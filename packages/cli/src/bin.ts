#!/usr/bin/env node
/**
 * 进程入口。**只做三件事**：取 argv、跑 main、把退出码交出去。
 */
import { main } from './index.js'

const code = await main(process.argv.slice(2))
process.exitCode = code
