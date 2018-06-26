'use strict';

const fs = require('fs');
const util = require('util');


const Ram = require('@alicloud/ram');
const FC = require('@alicloud/fc');
const ots = require('@alicloud/ots2');
const CloudAPI = require('@alicloud/cloudapi');


const getProfile = require('../profile').getProfile;
const zip = require('../zip');
const debug = require('debug')('fun:deploy');

const readFile = util.promisify(fs.readFile);

const { green } = require('colors');

const getFcClient = async () => {
  const profile = await getProfile();

  return new FC(profile.accountId, {
    accessKeyID: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    region: profile.defaultRegion,
    timeout: 60000
  });

};

const getOtsClient = async (instanceName) => {
  const profile = await getProfile();

  return ots.createClient({
    accessKeyID: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    instance: instanceName,
    region: profile.defaultRegion,
    keepAliveMsecs: 1000, // default 1000
    timeout: 3000 // default 3000ms
  });
};

const getCloudApiClient = async () => {
  const profile = await getProfile();

  return new CloudAPI({
    accessKeyId: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    endpoint: `http://apigateway.${profile.defaultRegion}.aliyuncs.com`
  });
};

async function makeService(serviceName, description) {
  const fc = await getFcClient();
  var service;
  try {
    service = await fc.getService(serviceName);
  } catch (ex) {
    if (ex.code !== 'ServiceNotFound') {
      throw ex;
    }
  }

  if (!service) {
    service = await fc.createService(serviceName, { description });
  } else {
    service = await fc.updateService(serviceName, { description });
  }

  return service;
}

async function getFunCodeAsBase64(codeUri) {
  if (codeUri) {
    if (codeUri.endsWith('.zip') || codeUri.endsWith('.jar')) {
      return Buffer.from(await readFile(codeUri)).toString('base64');
    }
  } else {
    codeUri = './';
  }

  return await zip.file(codeUri);
}

async function makeFunction({
  serviceName,
  functionName,
  description,
  handler,
  timeout = 3,
  memorySize = 128,
  runtime = 'nodejs6',
  codeUri
}) {
  const fc = await getFcClient();

  var fn;
  try {
    fn = await fc.getFunction(serviceName, functionName);
  } catch (ex) {
    if (ex.code !== 'FunctionNotFound') {
      throw ex;
    }
  }

  debug(`package function ${functionName}.`);
  const base64 = await getFunCodeAsBase64(codeUri);
  debug(`package function ${functionName}. done.`);

  const params = {
    description,
    handler,
    timeout,
    memorySize,
    runtime,
    code: {
      zipFile: base64
    }
  };

  if (!fn) {
    // create
    params['functionName'] = functionName;
    fn = await fc.createFunction(serviceName, params);
  } else {
    // update
    fn = await fc.updateFunction(serviceName, functionName, params);
  }

  return fn;
}

const triggerTypeMapping = {
  'Datahub': 'datahub',
  'Timer': 'timer'
};

function getTriggerConfig(triggerType, triggerProperties) {
  if (triggerType === 'Timer') {
    return {
      payload: triggerProperties.Payload,
      cronExpression: triggerProperties.CronExpression,
      enable: triggerProperties.Properties.Enable
    };
  }
}


async function makeTrigger({
  serviceName,
  functionName,
  triggerName,
  triggerType,
  triggerProperties
}) {
  const fc = await getFcClient();
  var trigger;
  try {
    trigger = await fc.getTrigger(serviceName, functionName, triggerName);
  } catch (ex) {
    if (ex.code !== 'TriggerNotFound') {
      throw ex;
    }
  }

  const params = {
    triggerType: triggerTypeMapping[triggerType],
    triggerConfig: getTriggerConfig(triggerProperties)
  };

  if (!trigger) {
    // create
    params.triggerName = triggerName;
    trigger = await fc.createTrigger(serviceName, functionName, params);
  } else {
    // update
    trigger = await fc.updateTrigger(serviceName, functionName, triggerName, params);
  }

  return trigger;
}

async function makeRole(roleName) {

  const profile = await getProfile();

  const ram = new Ram({
    accessKeyId: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    endpoint: 'https://ram.aliyuncs.com'
  });

  var role;
  try {
    role = await ram.getRole({
      RoleName: roleName
    }, { timeout: 10000 });
  } catch (ex) {
    if (ex.name !== 'EntityNotExist.RoleError') {
      throw ex;
    }
  }

  if (!role) {
    role = await ram.createRole({
      RoleName: roleName,
      Description: 'API网关访问 FunctionCompute',
      AssumeRolePolicyDocument: JSON.stringify({
        'Statement': [
          {
            'Action': 'sts:AssumeRole',
            'Effect': 'Allow',
            'Principal': {
              'Service': [
                'apigateway.aliyuncs.com'
              ]
            }
          }
        ],
        'Version': '1'
      })
    });
  }

  const policyName = 'AliyunFCInvocationAccess';
  const policies = await ram.listPoliciesForRole({
    RoleName: roleName
  });

  var policy = policies.Policies.Policy.find((item) => {
    return item.PolicyName === policyName;
  });

  if (!policy) {
    await ram.attachPolicyToRole({
      PolicyType: 'System',
      PolicyName: policyName,
      RoleName: roleName
    });
  }

  return role;
}

async function makeGroup(group) {
  const ag = await getCloudApiClient();

  const groupName = group.name;
  const groupDescription = group.description;

  var groups = await ag.describeApiGroups({
    GroupName: groupName
  }, { timeout: 10000 });

  var list = groups.ApiGroupAttributes.ApiGroupAttribute;
  var findGroup = list.find((item) => {
    return item.GroupName === groupName;
  });

  if (!findGroup) {
    findGroup = await ag.createApiGroup({
      GroupName: groupName,
      Description: groupDescription
    }, { timeout: 10000 });
  }

  return findGroup;
}

async function makeApi(group, {
  stageName,
  requestPath,
  method,
  role,
  apiName,
  serviceName,
  functionName,
  bodyFormat,
  parameters = [],
  auth = {},
  visibility
}) {
  const ag = await getCloudApiClient();

  const result = await ag.describeApis({
    ApiName: apiName,
    GroupId: group.GroupId
  });

  var api = result.ApiSummarys && result.ApiSummarys.ApiSummary[0];

  const requestParameters = parameters.map((item) => {
    return {
      ApiParameterName: item.name,
      Location: item.location || 'Query',
      ParameterType: item.type || 'String',
      Required: item.required
    };
  });
  const serviceParameters = parameters.map((item) => {
    return {
      ServiceParameterName: item.name,
      Location: item.location || 'Query',
      Type: item.type || 'String',
      ParameterCatalog: 'REQUEST'
    };
  });
  const serviceParametersMap = parameters.map((item) => {
    return {
      ServiceParameterName: item.name,
      RequestParameterName: item.name
    };
  });

  const profile = await getProfile();
  var params = {
    GroupId: group.GroupId,
    ApiName: apiName,
    Visibility: 'PUBLIC',
    Description: 'The awesome api',
    AuthType: 'ANONYMOUS',
    RequestConfig: JSON.stringify({
      'RequestHttpMethod': method,
      'RequestProtocol': 'HTTP',
      'BodyFormat': bodyFormat || '',
      'PostBodyDescription': '',
      'RequestPath': requestPath
    }),
    RequestParameters: JSON.stringify(requestParameters),
    ServiceParameters: JSON.stringify(serviceParameters),
    ServiceParametersMap: JSON.stringify(serviceParametersMap),
    ServiceConfig: JSON.stringify({
      'ServiceProtocol': 'FunctionCompute',
      'ContentTypeValue': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Mock': 'FALSE',
      'MockResult': '',
      'ServiceTimeout': 3 * 1000,
      'ServiceAddress': '',
      'ServicePath': '',
      'ServiceHttpMethod': '',
      'ContentTypeCatagory': 'DEFAULT',
      'ServiceVpcEnable': 'FALSE',
      FunctionComputeConfig: {
        FcRegionId: profile.defaultRegion,
        ServiceName: serviceName,
        FunctionName: functionName,
        RoleArn: role.Role.Arn
      }
    }),
    ResultType: 'PASSTHROUGH',
    ResultSample: 'result sample'
  };



  if (auth.type === 'OPENID') {
    var openidConf = auth.config || {};
    params.OpenIdConnectConfig = JSON.stringify({
      'IdTokenParamName': openidConf['id-token-param-name'] || 'token',
      'OpenIdApiType': openidConf['openid-api-type'] || 'BUSINESS',
      'PublicKeyId': openidConf['public-key-id'],
      'PublicKey': openidConf['public-key']
    });
  }
  
  if (!api) {
    api = await ag.createApi(params);
  } else {
    await ag.modifyApi(Object.assign(params, {
      ApiId: api.ApiId
    }));
  }
  
  await ag.deployApi({
    GroupId: group.GroupId,
    ApiId: api.ApiId,
    StageName: stageName,
    Description: `deployed by fun at ${new Date().toISOString()}`
  });

  const apiDetail = await ag.describeApi({
    GroupId: group.GroupId,
    ApiId: api.ApiId
  });

  console.log('    URL: %s http://%s%s',
    apiDetail.RequestConfig.RequestHttpMethod,
    group.SubDomain,
    apiDetail.RequestConfig.RequestPath);
  console.log(`      => ${api.function}`);
  apiDetail.DeployedInfos.DeployedInfo.forEach((info) => {
    if (info.DeployedStatus === 'DEPLOYED') {
      console.log(green(`      stage: ${info.StageName}, deployed, version: ${info.EffectiveVersion}`));
    } else {
      console.log(`      stage: ${info.StageName}, undeployed`);
    }
  });
}

async function makeApiTrigger({
  serviceName,
  functionName,
  triggerName,
  method = 'GET',
  requestPath,
  restApiId
}) {

  if (!restApiId) {
    const role = await makeRole('apigatewayAccessFC');
    debug('%j', role);

    
    const apiGroup = await makeGroup({
      name: `fc_${serviceName}_${functionName}`,
      description: `api group for function compute ${serviceName}/${functionName}`
    });

    const apiName = `fc_${serviceName}_${functionName}_${requestPath.replace(/\//g, '_')}_${method}`;
  
    makeApi(apiGroup, {
      stageName: 'RELEASE',
      requestPath,
      method,
      role,
      apiName,
      serviceName,
      functionName
    });
  }
}

async function makeOtsTrigger({
  serviceName,
  functionName,
  triggerName,
  stream
}) {

  const [, , , , path] = stream.split(':');
  const [, instance, , table] = path.split('/');

  console.error(`Try to create OTS Trigger of /instance/${instance}/table/${table}, but the SDK didn't OK.`);

}

async function makeOtsTable({
  instanceName,
  tableName,
  primaryKeys
}) {

  const client = await getOtsClient(instanceName);

  const tables = await client.listTable().catch(err => {
    if (err.errno === 'ENOTFOUND' && err.syscall === 'getaddrinfo') {
      console.error(`Instance '${err.hostname.split('.')[0]}' is not found.`);
    }
    throw err;
  });

  const options = {
    table_options: {
      time_to_live: -1,
      max_versions: 1
    }
  };
  const capacityUnit = { read: 0, write: 0 };

  const tbExist = tables.table_names.find(i => i === tableName);
  if (!tbExist) {
    console.log(`${tableName} not exist.`);
    await client.createTable(tableName, primaryKeys, capacityUnit, options);
  }
}

module.exports = {
  makeApi, makeApiTrigger, makeFunction,
  makeGroup, makeOtsTable, makeOtsTrigger,
  makeRole, makeService, makeTrigger
};