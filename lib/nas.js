'use strict';

const getProfile = require('./profile').getProfile;
const { getNasPopClient } = require('./client');
const _ = require('lodash');
const debug = require('debug')('fun:nas');
const { green } = require('colors');
const { sleep } = require('./time');

const requestOption = {
  method: 'POST'
};

const NAS_DEFAULT_DESCRIPTION = 'default_nas_created_by_fc_fun';

async function createMountTarget(nasClient, region, fileSystemId, vpcId, vswitchId) {
  const params = {
    'RegionId': region,
    'NetworkType': 'Vpc',
    'FileSystemId': fileSystemId,
    'AccessGroupName': 'DEFAULT_VPC_GROUP_NAME',
    'VpcId': vpcId,
    'VSwitchId': vswitchId
  };

  const rs = await nasClient.request('CreateMountTarget', params, requestOption);

  const mountTargetDomain = rs.MountTargetDomain;

  debug('create mount target rs: %s', mountTargetDomain);

  await waitMountPointUntilAvaliable(nasClient, region, fileSystemId, mountTargetDomain);

  return mountTargetDomain;
}

async function waitMountPointUntilAvaliable(nasClient, region, fileSystemId, mountTargetDomain) {
  let count = 0;
  let status;

  do {
    count++;

    var params = {
      'RegionId': region,
      'FileSystemId': fileSystemId,
      'MountTargetDomain': mountTargetDomain
    };

    await sleep(800);

    const rs = await nasClient.request('DescribeMountTargets', params, requestOption);

    status = rs.MountTargets.MountTarget[0].Status;

    debug('nas status is: ' + status);

    console.log(`\t\tnas mount target domain already created, waiting for status to be 'Active', now is ${status}`);

  } while (count < 15 && status !== 'Active');

  if (status !== 'Active') { throw new Error(`Timeout while waiting for MountPoint ${mountTargetDomain} status to be 'Active'`); }
}

async function createDefaultNasIfNotExist(vpcId, vswitchId) {
  const nasClient = await getNasPopClient();

  const profile = await getProfile();
  const region = profile.defaultRegion;

  const fileSystemId = await createNasFileSystemIfNotExist(nasClient, region);

  debug('fileSystemId: %s', fileSystemId);

  return await createMountTargetIfNotExist(nasClient, region, fileSystemId, vpcId, vswitchId);
}

async function findMountTarget(nasClient, region, fileSystemId, vpcId, vswitchId) {
  var params = {
    'RegionId': region,
    'FileSystemId': fileSystemId
  };

  const rs = await nasClient.request('DescribeMountTargets', params, requestOption);

  const mountTargets = rs.MountTargets.MountTarget;

  // todo: 检查 mountTargets 的 vswitch 是否与函数计算的一致？

  if (!_.isEmpty(mountTargets)) {

    const mountTarget = _.find(mountTargets, {
      'VpcId': vpcId,
      'VswId': vswitchId
    });

    if (mountTarget) {
      return mountTarget.MountTargetDomain;
    }
  }

  return null;
}

async function createMountTargetIfNotExist(nasClient, region, fileSystemId, vpcId, vswitchId) {
  let mountTargetDomain = await findMountTarget(nasClient, region, fileSystemId, vpcId, vswitchId);

  if (mountTargetDomain) {
    console.log(green('\t\tnas file system mount target is already created, mountTargetDomain is: ' + mountTargetDomain));

    return mountTargetDomain;
  }

  // create mountTarget if not exist

  console.log('\t\tcould not find default nas file system mount target, ready to generate one');

  mountTargetDomain = await createMountTarget(nasClient, region, fileSystemId, vpcId, vswitchId);

  console.log(green('\t\tdefault nas file system mount target has been generated, mount domain is: ' + mountTargetDomain));

  return mountTargetDomain;
}

async function createNasFileSystemIfNotExist(nasClient, region) {
  let fileSystemId = await findNasFileSystem(nasClient, region, NAS_DEFAULT_DESCRIPTION);

  if (!fileSystemId) {
    console.log('\t\tcould not find default nas file system, ready to generate one');

    fileSystemId = await createNasFileSystem(nasClient, region);

    console.log(green('\t\tdefault nas file system has been generated, fileSystemId is: ' + fileSystemId));
  } else {
    console.log(green('\t\tnas file system already generated, fileSystemId is: ' + fileSystemId));
  }

  return fileSystemId;
}

async function findNasFileSystem(nasClient, region, description) {

  const pageSize = 50;
  let requestPageNumber = 0;
  let totalCount;
  let pageNumber;

  let fileSystem;

  do {
    const params = {
      'RegionId': region,
      'PageSize': pageSize,
      'PageNumber': ++requestPageNumber
    };

    const rs = await nasClient.request('DescribeFileSystems', params, requestOption);

    totalCount = rs.TotalCount;
    pageNumber = rs.PageNumber;

    const fileSystems = rs.FileSystems.FileSystem;

    fileSystem = _.find(fileSystems, { Description: description });

    debug('find filesystem: ' + JSON.stringify(fileSystem));

  } while (!fileSystem && totalCount && pageNumber && pageNumber * pageSize < totalCount);

  return (fileSystem || {}).FileSystemId;
}

async function createNasFileSystem(nasClient, region) {
  const params = {
    'RegionId': region,
    'ProtocolType': 'NFS',
    'StorageType': 'Performance',
    'Description': NAS_DEFAULT_DESCRIPTION
  };

  const rs = await nasClient.request('CreateFileSystem', params, requestOption);

  return rs.FileSystemId;
}

async function generateAutoNasConfig(serviceName, vpcId, vswitchId) {
  const mountPointDomain = await createDefaultNasIfNotExist(vpcId, vswitchId);

  return {
    UserId: 10003,
    GroupId: 10003,
    MountPoints: [
      {
        ServerAddr: `${mountPointDomain}:/${serviceName}`,
        MountDir: '/mnt/auto'
      }
    ]
  };
}

const serverAddrReGe = /^[a-z0-9-.]*.nas.[a-z]+.com:\//;

function resolveMountPoint(mountPoint) {
  // '012194b28f-ujc20.cn-hangzhou.nas.aliyuncs.com:/'
  const serverAddr = mountPoint.ServerAddr;
  const mountDir = mountPoint.MountDir;

  // valid serverAddr
  if (!serverAddrReGe.test(serverAddr)) {
    throw new Error(`NASConfig's nas server address '${serverAddr}' doesn't match expected format (allowed: '^[a-z0-9-.]*.nas.[a-z]+.com:/')`);
  }

  const suffix = '.com:';
  const index = serverAddr.lastIndexOf(suffix);

  // /
  let mountSource = serverAddr.substr(index + suffix.length);
  // 012194b28f-ujc20.cn-hangzhou.nas.aliyuncs.com
  let serverPath = serverAddr.substr(0, serverAddr.length - mountSource.length - 1);

  return {
    serverPath,
    mountSource,
    mountDir,
    serverAddr
  };
}

module.exports = {
  findNasFileSystem,
  findMountTarget,
  createMountTarget,
  generateAutoNasConfig,
  resolveMountPoint
};