// 调试限流：直接 require dist 模块检查 metadata
const { AuthController } = require('./dist/modules/auth/auth.controller');
const { RateLimit } = require('./dist/common/guards/rate-limit.guard');

console.log('AuthController.prototype:', Object.getOwnPropertyNames(AuthController.prototype));
console.log('has RATE_LIMIT_KEY:', Object.getOwnPropertySymbols(AuthController.prototype));

// 用 dist 里的 symbol
const guard = require('./dist/common/guards/rate-limit.guard');
const symbolKey = Object.getOwnPropertySymbols(guard).find(s => s.toString().includes('rate_limit'));
console.log('symbol:', symbolKey, symbolKey?.toString());
if (symbolKey) {
  console.log('metadata on prototype:', AuthController.prototype[symbolKey]);
}
