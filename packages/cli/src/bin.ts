#!/usr/bin/env node
/**
 * 进程入口。**只做三件事**：取 argv、跑 main、把退出码交出去。
 *
 * 用 `process.exitCode` 而不是 `process.exit()`：后者会直接掐掉还没 flush 的
 * 异步写（--log-file 尤其容易丢最后几行），前者让事件循环自然排空。
 */
import { main } from './index.js'

const code = await main(process.argv.slice(2))
process.exitCode = code
