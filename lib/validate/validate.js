'use strict';

const fs = require('fs');
const util = require('util');

const yaml = require('js-yaml');
const _ = require('lodash');

const Ajv = require('ajv');
const readFile = util.promisify(fs.readFile);

const schemas = require('./schema');

const keyWordArray = ['oneOf','if','anyOf','false schema'];

async function validate(tplPath) {

  const tplContent = await readFile(tplPath, 'utf8');
  const tpl = yaml.safeLoad(tplContent);

  const ajv = new Ajv({ schemas, allErrors: true, jsonPointers: true });
  const valid = ajv.validate('/ROS', tpl);

  let errors;
  if (ajv.errors) {
    errors = ajv.errors.filter(p => !_.includes(keyWordArray,p.keyword)).map(m => _.omit(m,['schemaPath','emUsed']));
  }
  return { valid, ajv, tpl, errors };
}

module.exports = validate;