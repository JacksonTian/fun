'use strict';

const {
  generateDockerDebugOpts
} = require('./debug');

const debug = require('debug')('docker-opts');
const nestedObjectAssign = require('nested-object-assign');
const { addEnv } = require('./install/env');

const _ = require('lodash');

const { red } = require('colors');

const ping = require('ping');
const getVisitor = require('../lib/visitor').getVisitor;

const runtimeImageMap = {
  'nodejs6': 'nodejs6',
  'nodejs8': 'nodejs8',
  'python2.7': 'python2.7',
  'python3': 'python3.6',
  'java8': 'java8',
  'php7.2': 'php7.2'
};

function resolveDockerEnv(envs = {}) {
  return _.map(addEnv(envs || {}), (v, k) => `${k}=${v}`);
}

async function doImageRepoEventTag(el) {
  const visitor = await getVisitor();
  visitor.event({
    ec: 'imageRepo',
    ea: 'resolve',
    el 
  }).send();
}

async function doResolveDockerImageRepo(isDockerhubRegistry) {
  await doImageRepoEventTag('start');
  if (isDockerhubRegistry) {
    await doImageRepoEventTag('DockerhubRegistry');
    return '';
  }
  await doImageRepoEventTag('AliyunRegistry');
  return 'registry.cn-beijing.aliyuncs.com';
}

async function resolveDockerImageRepo() {
  try {
    const { alive, host } = await ping.promise.probe('google.com', { timeout: 10 });
    if (!alive && host !== 'unknown') {
      return doResolveDockerImageRepo(false);
    }
  } catch (error) {
    return doResolveDockerImageRepo(true);
  }
  return doResolveDockerImageRepo(true);
}

async function resolveRuntimeToDockerImage(runtime, isBuild) {
  if (runtimeImageMap[runtime]) {
    const name = runtimeImageMap[runtime];
    var imageName;
    if (isBuild) {
      imageName = `aliyunfc/runtime-${name}:build-1.5.6`;
    } else {
      imageName = `aliyunfc/runtime-${name}:1.5.6`;
    }

    const dockerImageRepo = await resolveDockerImageRepo();
    if (dockerImageRepo) {
      imageName = `${dockerImageRepo}/${imageName}`;
    }

    debug('imageName: ' + imageName);

    return imageName;
  }

  throw new Error(red(`invalid runtime name ${runtime}`));
}


function generateInstallOpts(imageName, mounts, envs) {
  return {
    Image: imageName,
    Tty: true,
    Env: resolveDockerEnv(envs),
    Cmd: ['/bin/bash'],
    HostConfig: {
      AutoRemove: true,
      Mounts: mounts
    }
  };
}

function transformPathForVirtualBox(source) {
  // C:\\Users\\image_crawler\\code -> /c/Users/image_crawler/code
  const sourcePath = source.split(':').join('');
  const lowerFirstAndReplace = _.lowerFirst(sourcePath.split('\\').join('/'));
  return '/' + lowerFirstAndReplace;
}

function transformMountsForToolbox(mounts) {

  console.warn(red(`We detected that you are using docker toolbox. For a better experience, please upgrade 'docker for windows'.\nYou can refer to Chinese doc https://github.com/alibaba/funcraft/blob/master/docs/usage/installation-zh.md#windows-%E5%AE%89%E8%A3%85-docker or English doc https://github.com/alibaba/funcraft/blob/master/docs/usage/installation.md.\n`));

  if (Array.isArray(mounts)) {
    return mounts.map(m => {

      return transformSourcePathOfMount(m);
    });
  } 
  return transformSourcePathOfMount(mounts);
}

function transformSourcePathOfMount(mountsObj) {

  if (!_.isEmpty(mountsObj)) {

    const replaceMounts = Object.assign({}, mountsObj);
    replaceMounts.Source = transformPathForVirtualBox(mountsObj.Source);
    return replaceMounts;
  }
  return {};
}

async function generateLocalInvokeOpts(runtime, containerName, mounts, cmd, debugPort, envs, dockerUser) {

  const hostOpts = {
    HostConfig: {
      AutoRemove: true,
      Mounts: mounts
    }
  };

  let debugOpts = {};

  if (debugPort) {
    debugOpts = generateDockerDebugOpts(runtime, debugPort);
  }

  const stdinOpts = {
    OpenStdin: true,
    Tty: false,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true
  };

  const imageName = await resolveRuntimeToDockerImage(runtime);

  const opts = nestedObjectAssign(
    {
      Env: resolveDockerEnv(envs),
      Image: imageName,
      name: containerName,
      Cmd: cmd,
      User: dockerUser
    },
    stdinOpts,
    hostOpts,
    debugOpts);


  debug('fc-docker docker options: %j', opts);

  return opts;
}

function resolveMockScript(runtime) {
  return `/var/fc/runtime/${runtime}/mock.sh`;
}

async function generateLocalStartRunOpts(runtime, name, mounts, cmd, debugPort, envs, dockerUser) {

  const hostOpts = {
    HostConfig: {
      AutoRemove: true,
      Mounts: mounts
    }
  };

  let debugOpts = {};

  if (debugPort) {
    debugOpts = generateDockerDebugOpts(runtime, debugPort);
  }

  const imageName = await resolveRuntimeToDockerImage(runtime);

  const opts = nestedObjectAssign(
    {
      Env: resolveDockerEnv(envs),
      Image: imageName,
      name,
      Cmd: cmd,
      User: dockerUser,
      Entrypoint: [resolveMockScript(runtime)]
    },
    hostOpts,
    debugOpts);

  debug('docker options: %j', opts);

  return opts;
}

module.exports = {
  generateLocalInvokeOpts, resolveRuntimeToDockerImage, 
  generateInstallOpts, generateLocalStartRunOpts,
  resolveMockScript, resolveDockerEnv, transformPathForVirtualBox,
  resolveDockerImageRepo, transformMountsForToolbox, transformSourcePathOfMount
};