'use strict';

const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const { red, green } = require('colors');
const debug = require('debug')('fun:deploy');

const frameworks = [
  // php
  require('./thinkphp'),

  // java
  require('./spring-boot'),

  // node
  require('./nuxt'),
  require('./express'),
  require('./next'),
  require('./hexo'),

  // go
  require('./go')
];

function resolvePath(p) {
  if (_.isArray(p)) {
    return path.join(...p);
  }
  return p;
}

const runtimeCheckers = {
  'nodejs': {
    'type': 'file',
    'path': 'package.json'
  },
  'java': {
    'type': 'file',
    'path': 'pom.xml'
  },
  'php': {
    'type': 'file',
    'path': 'composer.json'
  },
  'go': {
    'type': 'file',
    'paths': ['go.mod', 'Gopkg.toml', ['vendor', 'vendor.json'], ['Godeps', 'Godeps.json'], /\.go$/]
  }
};

async function parseRulePaths(codeDir, rule) {
  const rs = [];
  const paths = rule.paths || [rule.path];
  for (const relativePath of paths) {
    if (_.isRegExp(relativePath)) {
      const pathRegex = relativePath;
      const files = await fs.readdir(codeDir);

      for (const file of files) {
        if (pathRegex.test(file)) {
          rs.push(path.join(codeDir, file));
        }
      }
    } else {
      rs.push(path.join(codeDir, resolvePath(relativePath)));
    }
  }

  return rs;
}

async function readJsonFile(p) {
  if (!await fs.pathExists(p)) { return { success: false }; }

  try {
    const content = await fs.readFile(p);
    const json = JSON.parse(content.toString());
    return { success: true, json };
  } catch (e) {
    debug('readJsonFile error', e);
    return { success: false };
  }
}

async function checkJsonRule(codeDir, rule) {
  const p = path.join(codeDir, resolvePath(rule.path));
  const jsonKey = rule.jsonKey;
  const jsonValueContains = rule.jsonValueContains;

  const { success, json } = await readJsonFile(p);
  if (!success) { return success; }
  if (!_.has(json, jsonKey)) { return false; }

  const value = _.get(json, jsonKey);
  if (jsonValueContains !== undefined && jsonValueContains !== null) {
    return _.includes(value, jsonValueContains);
  }
  return true;
}

async function checkContainsRule(codeDir, rule) {
  const paths = await parseRulePaths(codeDir, rule);
  const content = rule.content;
  for (const p of paths) {
    if (!await fs.pathExists(p)) { continue; }
    const fileContent = await fs.readFile(p, 'utf8');

    if (_.includes(fileContent, content)) { return true; }
  }

  return false;
}

async function checkDirRule(codeDir, rule) {
  const paths = await parseRulePaths(codeDir, rule);

  for (const p of paths) {
    if (await fs.pathExists(p)) {
      const stat = await fs.stat(p);
      return stat.isDirectory();
    }
  }

  return false;
}

async function checkFileRule(codeDir, rule) {
  const paths = await parseRulePaths(codeDir, rule);
  for (const f of paths) {
    if (await fs.pathExists(f)) {
      const stat = await fs.stat(f);
      if (stat.isFile()) return true;
    }
  }

  return false;
}

async function checkRegexRule(codeDir, rule) {
  const paths = await parseRulePaths(codeDir, rule);

  const regexContent = rule.content;
  const regex = new RegExp(regexContent, 'gm');

  for (const p of paths) {
    if (!await fs.pathExists(p)) { continue; }
    const fileContent = await fs.readFile(p);

    const match = regex.test(fileContent.toString());
    if (match) { return match; }
  }

  return false;
}

async function checkRule(codeDir, rule) {
  const type = rule.type;

  switch (type) {
    case 'json':
      return await checkJsonRule(codeDir, rule);
    case 'regex':
      return await checkRegexRule(codeDir, rule);
    case 'contains':
      return await checkContainsRule(codeDir, rule);
    case 'dir':
      return await checkDirRule(codeDir, rule);
    case 'file':
      return await checkFileRule(codeDir, rule);
    default:
      throw new Error(`rule type ${type} not supported`);
  }
}

async function checkRules(codeDir, rules) {
  const andRules = rules.and;
  if (andRules) {
    const checkResultPromises = _.map(andRules, (rule) => {
      return checkRule(codeDir, rule);
    });

    const everyResults = await Promise.all(checkResultPromises);

    const match = _.every(everyResults, (r) => r);
    return match;
  }

  const orRules = rules.or;
  if (orRules) {
    const checkResultPromises = _.map(orRules, (rule) => {
      return checkRule(codeDir, rule);
    });

    const everyResults = await Promise.all(checkResultPromises);

    const match = _.some(everyResults, (r) => r);
    return match;
  }

  return false;
}

async function execProcessor(codeDir, processor) {
  debug('exec processor', processor);
  switch (processor.type) {
    case 'function': {
      const func = processor.function;
      await func(codeDir);
      return;
    }
    case 'generateFile': {
      let p = resolvePath(processor.path);
      p = path.join(codeDir, p);

      await fs.ensureDir(path.dirname(p));

      const mode = processor.mode;
      const content = processor.content;

      console.log(green('Generating ' + p + '...'));
      if (await fs.pathExists(p)) {
        const backup = processor.backup;
        if (_.isNil(backup) || backup) {
          console.warn(red(`File ${p} already exists, Fun will rename to ${p}.bak`));

          await fs.copyFile(p, `${p}.bak`, {
            overwrite: true
          });
        }
      }

      await fs.writeFile(p, content, {
        mode
      });
      return;
    }
    default:
      throw new Error(`not supported processor ${JSON.stringify(processor)}`);
  }
}

async function detectFramework(codeDir) {
  for (const framework of frameworks) {
    const runtime = framework.runtime;
    const runtimeChecker = runtimeCheckers[runtime];

    if (!runtimeChecker) {
      throw new Error('could not found runtime checker');
    }

    const checkResult = await checkRule(codeDir, runtimeChecker);

    if (checkResult) {
      const detectors = framework.detectors;

      // no need to detect
      if (_.isEmpty(detectors)) return framework;

      const match = await checkRules(codeDir, detectors);
      if (match) {
        return framework;
      }
    }
  }

  return null;
}

async function execFrameworkActions(codeDir, framework) {
  const actions = framework.actions;

  if (actions) {
    for (const action of actions) {
      const condition = action.condition;

      if (_.isBoolean(condition)) {
        if (!condition) { continue; }
      } else if (condition) {
        const checkResult = await checkRules(codeDir, condition);
        debug(`action condition ${JSON.stringify(condition, null, 4)}, checkResult ${checkResult}`);

        if (!checkResult) { continue; }
      } else {
        throw new Error(`not supported condition value ${condition}`);
      }

      const processors = action.processors;
      for (const processor of processors) {
        await execProcessor(codeDir, processor);
      }
    }
  }
}

async function generateTemplateContent(folderName) {
  const templateYmlContent = `ROSTemplateFormatVersion: '2015-09-01'
Transform: 'Aliyun::Serverless-2018-04-03'
Resources:
  ${folderName}: # service name
    Type: 'Aliyun::Serverless::Service'
    Properties:
      Description: This is FC service
    ${folderName}: # function name
      Type: 'Aliyun::Serverless::Function'
      Properties:
        Handler: index.handler
        Runtime: custom
        CodeUri: ./
        MemorySize: 1024
        InstanceConcurrency: 5
        Timeout: 120
      Events:
        httpTrigger:
          Type: HTTP
          Properties:
            AuthType: ANONYMOUS
            Methods: ['GET', 'POST', 'PUT']
  Domain:
    Type: Aliyun::Serverless::CustomDomain
    Properties:
      DomainName: Auto
      Protocol: HTTP
      RouteConfig:
        Routes:
          "/*":
            ServiceName: ${folderName}
            FunctionName: ${folderName}
  `;
  return templateYmlContent;
}

module.exports = {
  detectFramework,
  generateTemplateContent,
  execFrameworkActions
};