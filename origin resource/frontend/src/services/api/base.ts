/**
 * 所有前端 API 请求共用的基础路径。开发环境会由 Vite 转发到后端。
 *
 * 单独放一个文件是为了打断循环依赖：http.ts 需要 diagnostics 记请求日志，
 * 而 diagnostics 又需要这个常量拼上报地址。常量独立后两边都只依赖它。
 */
export const API_BASE = '/api'
