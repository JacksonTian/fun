'use strict';

const { isEmptyDir } = require('../nas/cp/file');
const { getOssClient } = require('../client');
const { parseMountDirPrefix } = require('../fc');
const { red, green, yellow } = require('colors');
const { getTpl, detectNasBaseDir, getNasYmlPath } = require('../tpl');
const { validateNasAndVpcConfig, SERVICE_RESOURCE, iterateResources, isNasAutoConfig, getUserIdAndGroupId } = require('../definition');

const fs = require('fs-extra');
const {
  promptForConfirmContinue,
  promptForInput
} = require('../init/prompt');
const { getProfile } = require('../profile');

const nas = require('../nas');
const path = require('path');
const util = require('../import/utils');
const nasSupport = require('../nas/support');

const _ = require('lodash');

const {
  zipToOss,
  transformFlowDefinition,
  uploadNasService,
  uploadAndUpdateFunctionCode,
  generateRosTemplateForRegionMap,
  generateRosTemplateForVpcConfig,
  generateRosTemplateForNasConfig,
  generateRosTemplateForNasService,
  generateRosTemplateForEventOutputs,
  generateRosTemplateForNasCpInvoker,
  generateRosTemplateForWaitCondition,
  generateRosTemplateForDefaultOutputs,
  generateRosTemplateForDefaultResources
} = require('./template');

async function processNasAutoToRosTemplate({ tpl, baseDir, tplPath,
  ossClient,
  bucketName
}) {
  const cloneTpl = _.cloneDeep(tpl);

  const servicesNeedUpdate = [];
  iterateResources(cloneTpl.Resources, SERVICE_RESOURCE, (serviceName, serviceRes) => {
    const nasConfig = (serviceRes.Properties || {}).NasConfig;
    if (isNasAutoConfig(nasConfig)) {
      servicesNeedUpdate.push({
        serviceName,
        serviceRes
      });
    }
  });

  if (_.isEmpty(servicesNeedUpdate)) { return cloneTpl; }

  const serviceNasMapping = await nas.convertTplToServiceNasMappings(detectNasBaseDir(tplPath), tpl);
  const mergedNasMapping = await nasSupport.mergeNasMappingsInNasYml(getNasYmlPath(tplPath), serviceNasMapping);

  let count = 0;
  let totalObjectNames = [];
  for (const { serviceName, serviceRes } of servicesNeedUpdate) {
    const serviceProp = (serviceRes.Properties || {});
    const nasConfig = serviceProp.NasConfig;

    const { userId, groupId } = getUserIdAndGroupId(nasConfig);

    serviceProp.VpcConfig = generateRosTemplateForVpcConfig();
    serviceProp.NasConfig = generateRosTemplateForNasConfig(serviceName, userId, groupId);

    const objectNames = [];
    for (const { localNasDir, remoteNasDir } of mergedNasMapping[serviceName]) {
      const srcPath = path.resolve(baseDir, localNasDir);

      if (!await fs.pathExists(srcPath)) {
        console.warn(`\n${srcPath} is not exist, skiping.`);
        continue;
      }
      if (await isEmptyDir(srcPath)) {
        console.warn(`\n${srcPath} is empty directory, skiping.`);
        continue;
      }
      const prefix = path.relative(parseMountDirPrefix(nasConfig), remoteNasDir);
      const objectName = await zipToOss(ossClient, srcPath, null, 'nas.zip', prefix);

      if (!objectName) {
        console.warn(`\n${srcPath} is empty directory, skiping.`);
        continue;
      }
      objectNames.push(objectName);
      totalObjectNames.push(objectName);
    }

    if (_.isEmpty(objectNames)) {
      console.warn(red(`\nwarning: There is no local NAS directory available under service: ${serviceName}.`));
      continue;
    }

    const customizer = (objValue, srcValue) => {
      return _.isEmpty(objValue) ? srcValue : _.merge(objValue, srcValue);
    };

    _.assignWith(cloneTpl, generateRosTemplateForEventOutputs(bucketName, objectNames, serviceName), customizer);

    Object.assign(cloneTpl.Resources, generateRosTemplateForNasCpInvoker(serviceName, bucketName, objectNames));

    count ++;
  }

  if (_.isEmpty(totalObjectNames)) { return cloneTpl; } // TODO: 将 tpl 中 NasConfig 正确展开到 template.package.yml 中

  const codeUri = await uploadNasService(ossClient);

  Object.assign(cloneTpl.Resources, generateRosTemplateForNasService(codeUri));
  Object.assign(cloneTpl.Resources, generateRosTemplateForDefaultResources());
  Object.assign(cloneTpl.Resources, generateRosTemplateForWaitCondition(count));
  Object.assign(cloneTpl, generateRosTemplateForRegionMap());

  return _.merge(cloneTpl, generateRosTemplateForDefaultOutputs());
}

async function generateDefaultOSSBucket() {
  const profile = await getProfile();
  const bucketName = `fun-gen-${profile.defaultRegion}-${profile.accountId}`;
  console.log(yellow(`using oss-bucket: ${bucketName}`));

  const ossClient = await getOssClient();
  let bucketExist = false;
  try {
    await ossClient.getBucketLocation(bucketName);
    bucketExist = true;
  } catch (ex) {
    if (!ex.code || ex.code !== 'NoSuchBucket') {
      throw ex;
    }
  }
  if (bucketExist) {
    return bucketName;
  }
  if (!await promptForConfirmContinue('Auto generate OSS bucket for you:')) {
    return (await promptForInput('Input OSS bucket name:')).input;
  }
  await ossClient.putBucket(bucketName);
  return bucketName;
}

async function pack(tplPath, bucket, outputTemplateFile) {
  const tpl = await getTpl(tplPath);
  validateNasAndVpcConfig(tpl.Resources);

  const baseDir = path.dirname(tplPath);

  if (!bucket) {
    bucket = await generateDefaultOSSBucket();
  }
  if (!bucket) {
    throw new Error('Missing OSS bucket');
  }
  const ossClient = await getOssClient(bucket);
  const updatedCodeTpl = await uploadAndUpdateFunctionCode({ tpl, tplPath, baseDir, ossClient });
  const updatedFlowTpl = await transformFlowDefinition(baseDir, updatedCodeTpl);

  const updatedTpl = await processNasAutoToRosTemplate({ ossClient, baseDir, tplPath,
    tpl: updatedFlowTpl,
    bucketName: bucket
  });

  let packedYmlPath;

  if (outputTemplateFile) {
    packedYmlPath = path.resolve(process.cwd(), outputTemplateFile);
  } else {
    packedYmlPath = path.join(process.cwd(), 'template.packaged.yml');
  }

  util.outputTemplateFile(packedYmlPath, updatedTpl);

  console.log(green('\nPackage success'));

  showPackageNextTips(packedYmlPath);
}

function showPackageNextTips(packedYmlPath) {
  const deployTip = 'fun deploy';

  const relative = path.relative(process.cwd(), packedYmlPath);

  let templateParam = '';

  const DEFAULT_PACKAGED_YAML_NAME = 'template.packaged.yml';

  if (relative !== DEFAULT_PACKAGED_YAML_NAME) {
    templateParam = ` -t ${relative}`;
  }

  console.log(yellow(`\nTips for next step
======================
* Deploy Resources: ${deployTip}${templateParam}`));
}

module.exports = {
  pack
};