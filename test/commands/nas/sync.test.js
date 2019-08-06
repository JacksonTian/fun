'use strict';

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const mockdata = require('./mock-data');
const fs = require('fs-extra');
const path = require('path');
const sandbox = sinon.createSandbox();
const assert = sinon.assert;

const cp = sandbox.stub();
const validate = sandbox.stub();

const tpl = {
  detectTplPath: sandbox.stub().returns('/demo/template.yml'), 
  getTpl: sandbox.stub().returns(mockdata.tpl)
};

const syncStub = proxyquire('../../../lib/commands/nas/sync', {
  '../../validate/validate': validate,
  '../../nas/cp': cp,
  '../../tpl': tpl
});

describe('fun nas sync test', () => {
  let fsPathExists;
  beforeEach(() => {
    fsPathExists = sandbox.stub(fs, 'pathExists');
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('sync test', async () => {
    fsPathExists.onCall(0).resolves(true);
    fsPathExists.onCall(1).resolves(true);
    const options = {
      service: undefined, 
      mntDirs: undefined
    };

    await syncStub(options);
    const localNasDir = path.join('/', 'demo', '.fun', 'nas', '359414a1be-lwl67.cn-shanghai.nas.aliyuncs.com', '/');
    assert.calledWith(cp, localNasDir, 'nas://fun-nas-test:/mnt/nas/', true);
  });

});