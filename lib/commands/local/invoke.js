'use strict';

const path = require('path');
const debug = require('debug')('fun:local');

const validate = require('../../validate/validate');

const definition = require('../../definition');
const fc = require('../../fc');
const { getDebugPort, getDebugIde } = require('../../debug');

const { detectTplPath, getTpl } = require('../../tpl');
const { getEvent } = require('../../utils/file');
const { red, yellow } = require('colors');

function parseInvokeName(invokeName) {
  let serviceName = null;
  let functionName = null;

  let index = invokeName.indexOf('/');

  if (index < 0) {
    functionName = invokeName;
  } else {
    serviceName = invokeName.substring(0, index);
    functionName = invokeName.substring(index + 1);
  }

  debug(`invoke service: ${serviceName}`);

  debug(`invoke function: ${functionName}`);

  return [serviceName, functionName];
}

async function localInvoke(invokeName, tpl, debugPort, event, debugIde, tplPath) {
  debug(`invokeName: ${invokeName}`);

  if (!invokeName) {

    invokeName = definition.findFirstFunction(tpl);

    if (!invokeName) {
      throw new Error(red(`Missing function definition in template.yml`)); 
    }
    
    console.log(`\nMissing invokeName argument, Fun will use the first function ${yellow(invokeName)} as invokeName\n`);
  }

  const [parsedServiceName, parsedFunctionName] = parseInvokeName(invokeName);

  debug(`parse service name ${parsedServiceName}, functionName ${parsedFunctionName}`);

  const {serviceName, serviceRes, functionName, functionRes} = definition.findFunctionInTpl(parsedServiceName, parsedFunctionName, tpl);

  if (!functionRes) {
    throw new Error(red(`invokeName ${invokeName} is invalid`));
  }
  const codeUri = functionRes.Properties.CodeUri;
  const runtime = functionRes.Properties.Runtime;
  await fc.detectLibrary(codeUri, runtime, path.dirname(tplPath), functionName);

  debug(`found serviceName: ${serviceName}, functionName: ${functionName}, functionRes: ${functionRes}`);

  // Lazy loading to avoid stdin being taken over twice.
  const LocalInvoke = require('../../local/local-invoke');
  const localInvoke = new LocalInvoke(serviceName, serviceRes, functionName, functionRes, debugPort, debugIde, tplPath);

  await localInvoke.invoke(event);
}

async function invoke(invokeName, options) {

  const tplPath = await detectTplPath();

  if (!tplPath) {
    throw new Error(red('Current folder not a fun project\nThe folder must contains template.[yml|yaml] or faas.[yml|yaml] .'));
  } else if (path.basename(tplPath).startsWith('template')) {

    await validate(tplPath);

    const tpl = await getTpl(tplPath);

    const event = await getEvent(options.event);

    debug('event content: ' + event);

    const debugPort = getDebugPort(options);

    const debugIde = getDebugIde(options);

    await localInvoke(invokeName, tpl, debugPort, event, debugIde, tplPath);
  } else {
    throw new Error(red('The template file name must be template.[yml|yaml].'));
  }
}

module.exports = { invoke, parseInvokeName };
