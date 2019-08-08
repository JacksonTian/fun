'use strict';

const definition = require('../definition');
const docker = require('../docker');
const dockerOpts = require('../docker-opts');
const debug = require('debug')('fun:local');
const path = require('path');
const fs = require('fs-extra');
const rimraf = require('rimraf');
const unzipper = require('unzipper');
const tmpDir = require('temp-dir');
const uuid = require('uuid');

function isZipArchive(codeUri) {
  return codeUri.endsWith('.zip') || codeUri.endsWith('.jar') || codeUri.endsWith('.war');
}

async function processZipCodeIfNecessary(codeUri) {

  if (isZipArchive(codeUri)) {
    const stream = fs.createReadStream(codeUri);

    const tmpCodeDir = path.join(tmpDir, uuid.v4());

    await fs.ensureDir(tmpCodeDir);

    console.log(`codeUri is a zip format, will unzipping to ${tmpCodeDir}`);

    await stream.pipe(unzipper.Extract({ path: tmpCodeDir })).promise();
    return tmpCodeDir;
  } 

  return null;
}

class Invoke {

  constructor(serviceName, serviceRes, functionName, functionRes, debugPort, debugIde, tplPath) {
    this.serviceName = serviceName;
    this.serviceRes = serviceRes;
    this.functionName = functionName;
    this.functionRes = functionRes;
    this.functionProps = functionRes.Properties;
    this.debugPort = debugPort;
    this.debugIde = debugIde;
    this.tplPath = tplPath;

    this.runtime = this.functionProps.Runtime;

    if (tplPath) {
      this.baseDir = path.dirname(tplPath);
    } else {
      this.baseDir = process.cwd();
    }

    this.codeUri = path.resolve(this.baseDir, this.functionProps.CodeUri);
  }

  async invoke() {
    if (!this.inited) {
      await this.init();
      this.inited = true;
    }

    await this.beforeInvoke();
    await this.showDebugIdeTips();
    await this.doInvoke(...arguments);
    await this.afterInvoke();
  }

  async init() {
    this.nasConfig = definition.findNasConfigInService(this.serviceRes);
    this.dockerUser = await docker.resolveDockerUser(this.nasConfig);
    this.nasMounts = await docker.resolveNasConfigToMounts(this.serviceName, this.nasConfig, this.tplPath);

    this.unzippedCodeDir = await processZipCodeIfNecessary(this.codeUri);
    this.codeMount = await docker.resolveCodeUriToMount(this.unzippedCodeDir || this.codeUri);

    const allMount = [this.codeMount, ...this.nasMounts];

    const isDockerToolBox = await docker.isDockerToolBox();

    if (isDockerToolBox) {
      this.mounts = dockerOpts.transformMountsForToolbox(allMount);
    } else {
      this.mounts = allMount;
    }

    debug(`docker mounts: %s`, JSON.stringify(this.mounts, null, 4));

    this.containerName = docker.generateRamdomContainerName();

    this.imageName = await dockerOpts.resolveRuntimeToDockerImage(this.runtime);

    await docker.pullImageIfNeed(this.imageName);
  }

  async beforeInvoke() {

  }

  async showDebugIdeTips() {
    if (this.debugPort && this.debugIde) {
      await docker.showDebugIdeTips(this.serviceName, this.functionName, this.runtime, this.codeMount.Source, this.debugPort);
    }
  }

  cleanUnzippedCodeDir() {
    if (this.unzippedCodeDir) {
      rimraf.sync(this.unzippedCodeDir);
      console.log(`clean tmp code dir ${this.unzippedCodeDir} successfully`);
      this.unzippedCodeDir = null;
    }
  }

  async afterInvoke() {
    this.cleanUnzippedCodeDir();
  }
}

module.exports = Invoke;
