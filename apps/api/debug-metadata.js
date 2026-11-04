// 检查 dist 里 AuthController 方法上的 metadata
const { AuthController } = require('./dist/modules/auth/auth.controller');
console.log('AuthController.prototype.login has metadata?');

// Reflect.getMetadata
const KEY = 'rate_limit_options';
try {
  const meta = require('reflect-metadata');
  console.log('reflect-metadata available');
} catch { console.log('no reflect-metadata, using nestjs'); }

const core = require('@nestjs/core');
// 用 NestJS 的 Reflector
const reflector = new core.Reflector();

const loginHandler = AuthController.prototype.login;
const classRef = AuthController;

// getAllAndOverride 接受 handler 和 class
const result = reflector.getAllAndOverride('rate_limit_options', [loginHandler, classRef]);
console.log('Reflector result:', result);

// 也直接在 prototype 上搜 symbol
const symbols = Object.getOwnPropertySymbols(loginHandler);
console.log('symbols on login:', symbols.map(s => s.toString()));
