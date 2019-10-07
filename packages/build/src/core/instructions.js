const execa = require('execa')
const pMapSeries = require('p-map-series')
const pReduce = require('p-reduce')
require('array-flat-polyfill')

const { executePlugin } = require('../plugins/ipc')
const { logInstruction, logCommandStart, logCommandError, logInstructionSuccess } = require('../log/main')
const { setLogContext, unsetLogContext } = require('../log/patch')
const { redactProcess } = require('../log/patch')
const { startTimer, endTimer } = require('../log/timer')

const { LIFECYCLE } = require('./lifecycle')

// Get instructions for all hooks
const getInstructions = function({ pluginsHooks, config }) {
  const instructions = LIFECYCLE.flatMap(hook => getHookInstructions({ hook, pluginsHooks, config }))
  const buildInstructions = instructions.filter(({ hook }) => hook !== 'onError')
  const errorInstructions = instructions.filter(({ hook }) => hook === 'onError')
  return { buildInstructions, errorInstructions }
}

// Get instructions for a specific hook
const getHookInstructions = function({
  hook,
  pluginsHooks: { [hook]: pluginHooks = [] },
  config: {
    build: {
      lifecycle: { [hook]: commands }
    }
  }
}) {
  if (commands === undefined) {
    return pluginHooks
  }

  const lifeCycleHook = { name: `config.build.lifecycle.${hook}`, hook, commands, override: {} }
  return [lifeCycleHook, ...pluginHooks]
}

// Run a set of instructions
const runInstructions = async function(instructions, { config, configPath, token, baseDir, redactedKeys, error }) {
  return await pReduce(
    instructions,
    (currentData, instruction, index) =>
      runInstruction(instruction, { currentData, index, config, configPath, token, baseDir, redactedKeys, error }),
    {}
  )
}

// Run a single instruction
const runInstruction = async function(
  instruction,
  { currentData, index, config, configPath, token, baseDir, redactedKeys, error }
) {
  const { name, hook } = instruction

  const methodTimer = startTimer()

  logInstruction(instruction, { index, configPath, error })

  setLogContext(name)

  try {
    const pluginReturnValue = await fireMethod(instruction, { baseDir, redactedKeys, config, token, error })

    logInstructionSuccess()
    unsetLogContext()

    endTimer(methodTimer, name, hook)

    return Object.assign({}, currentData, pluginReturnValue)
  } catch (error) {
    unsetLogContext()

    error.message = `Error in '${name}' plugin:\n${error.message}`
    throw error
  }
}

const fireMethod = function(instruction, { baseDir, redactedKeys, config, token, error }) {
  if (instruction.commands !== undefined) {
    return execCommands(instruction, { baseDir, redactedKeys })
  }

  return firePluginHook(instruction, { config, token, baseDir, redactedKeys, error })
}

// Fire a `config.lifecycle.*` series of commands
const execCommands = async function({ hook, commands }, { baseDir, redactedKeys }) {
  await pMapSeries(commands, command => execCommand({ hook, command, baseDir, redactedKeys }))
}

const execCommand = async function({ hook, command, baseDir, redactedKeys }) {
  logCommandStart(command)

  try {
    const childProcess = execa(command, { shell: true, cwd: baseDir })
    redactProcess(childProcess, redactedKeys)
    await childProcess
  } catch (error) {
    logCommandError(command, hook, error)
    throw error
  }
}

// Fire a plugin hook method
const firePluginHook = async function(
  { type, hook, pluginPath, pluginConfig, hookName, constants },
  { config, token, baseDir, redactedKeys, error }
) {
  try {
    await executePlugin(
      'run',
      { pluginPath, pluginConfig, hookName, config, token, error, constants },
      { baseDir, redactedKeys }
    )
  } catch (error) {
    logCommandError(type, hook, error)
    throw error
  }
}

module.exports = { getInstructions, runInstructions }
