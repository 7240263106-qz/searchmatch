export interface ErrorDefinition {
  httpStatus: number;
  message: string;
}

export const ERROR_CODES = {
  AUTH_UNAUTHORIZED: { httpStatus: 401, message: '未登录或登录已过期' },
  AUTH_FORBIDDEN: { httpStatus: 403, message: '没有执行该操作的权限' },
  RESOURCE_NOT_FOUND: { httpStatus: 404, message: '资源不存在或无权访问' },
  VALIDATION_FAILED: { httpStatus: 400, message: '请求参数不合法' },
  QUERY_CONDITION_INVALID: { httpStatus: 400, message: '查询条件不合法' },
  QUERY_TIMEOUT: { httpStatus: 408, message: '查询超时，请收窄筛选条件' },
  RATE_LIMITED: { httpStatus: 429, message: '请求过于频繁，请稍后再试' },
  INTERNAL_ERROR: { httpStatus: 500, message: '服务暂时不可用' },

  FILE_LIMIT_EXCEEDED: { httpStatus: 400, message: '上传文件数量或总量超出限制' },
  FILE_SIZE_EXCEEDED: { httpStatus: 413, message: '单个文件超过 20MB 限制' },
  FILE_FORMAT_UNSUPPORTED: { httpStatus: 415, message: '不支持该文件格式' },
  FILE_SECURITY_REJECTED: { httpStatus: 422, message: '文件未通过安全校验' },
  FILE_UNREADABLE: { httpStatus: 422, message: '文件内容无法安全解析' },

  DRAFT_VERSION_CONFLICT: { httpStatus: 409, message: '草稿已在其他位置被修改' },
  DOCUMENT_DUPLICATE: { httpStatus: 409, message: '相同文件已上传' },
  PARSE_TIMEOUT: { httpStatus: 408, message: '解析超时，已保留部分结果' },
  PARSE_TASK_NOT_FOUND: { httpStatus: 404, message: '解析任务不存在' },
  EXTRACT_SCHEMA_INVALID: { httpStatus: 422, message: '抽取结果不符合字段规范' },
  TIME_CONFLICT: { httpStatus: 409, message: '存在多个冲突时间，需人工确认' },
  TIME_UNDETERMINED: { httpStatus: 422, message: '时间无法可靠确定' },

  STATE_TRANSITION_INVALID: { httpStatus: 409, message: '当前状态不允许该操作' },
  REVIEW_COMMENT_REQUIRED: { httpStatus: 400, message: '退回、下架、合并与拆分必须填写审核意见' },
  VERSION_NOT_FOUND: { httpStatus: 404, message: '版本不存在' },

  SOURCE_DUPLICATE: { httpStatus: 409, message: '该范围内已存在相同信息源' },
  SOURCE_CONFLICT: { httpStatus: 409, message: '信息源已被其他人修改' },
  SOURCE_UNREACHABLE: { httpStatus: 502, message: '信息源暂时无法访问' },
  SOURCE_ADDRESS_FORBIDDEN: { httpStatus: 400, message: '该地址不被允许采集' },

  SIGNUP_ENTRY_LIMIT: { httpStatus: 400, message: '报名入口数量超出限制' },
  SIGNUP_METHOD_REQUIRED: { httpStatus: 400, message: '必须选择报名方式' },
  SIGNUP_URL_REQUIRED: { httpStatus: 400, message: '网页报名必须提供有效地址' },
  SIGNUP_REDIRECT_SUSPECT: { httpStatus: 409, message: '跳转目标存在风险，需要确认' },

  IMPORT_PARTIAL_FAILED: { httpStatus: 207, message: '部分行导入失败，成功行已入库' },
  TABLE_MAPPING_REQUIRED: { httpStatus: 400, message: '必填列尚未映射' },
  IMPORT_NOT_FOUND: { httpStatus: 404, message: '导入任务不存在' },

  AGENT_UNAVAILABLE: { httpStatus: 503, message: '智能解析服务暂不可用，已降级为规则模式' },
  AGENT_WRITE_NOT_CONFIRMED: { httpStatus: 409, message: '写操作需显式确认后执行' },
  AGENT_PERMISSION_DENIED: { httpStatus: 403, message: '无权访问目标数据' },
  INTENT_UNCLEAR: { httpStatus: 400, message: '未能理解意图，请换一种说法' },

  IDEMPOTENCY_CONFLICT: { httpStatus: 409, message: '相同幂等键的请求正在处理中' },
  DASHBOARD_LOAD_FAILED: { httpStatus: 502, message: '看板数据加载失败' },
  TASK_NOT_FOUND: { httpStatus: 404, message: '任务不存在' },
  TASK_REPLAY_FAILED: { httpStatus: 409, message: '任务当前状态不支持重放' },
  SECURITY_PROMPT_INJECTION: { httpStatus: 422, message: '内容包含疑似指令注入，仅作原文保留' },
  SECURITY_SSRF_BLOCKED: { httpStatus: 400, message: '目标地址不被允许访问' },

  CONF_VALUE_INVALID: { httpStatus: 422, message: '配置值不合法' },
  CONF_CONNECT_FAILED: { httpStatus: 422, message: '连接测试失败' },
  CONF_VERSION_CONFLICT: { httpStatus: 409, message: '配置已更新，请基于最新版本重新编辑' },
  CONF_CREDENTIAL_MISSING: { httpStatus: 422, message: '凭据缺失或引用无效' },
  CONF_MODEL_TEST_FAILED: { httpStatus: 422, message: '模型验证失败' },
  CONF_CREDENTIAL_IN_USE: { httpStatus: 409, message: '凭据仍被启用配置引用，不能删除' },
  CONF_RESTART_REQUIRED: { httpStatus: 200, message: '配置已保存，需重启后生效' },
  CONF_FORBIDDEN: { httpStatus: 403, message: '没有系统配置权限' },
  CONF_ADDRESS_FORBIDDEN: { httpStatus: 422, message: '该地址未通过安全校验' },
  CONF_ROLLBACK_FAILED: { httpStatus: 409, message: '配置回滚失败' },
  CONF_DEV_IDENTITY_FORBIDDEN: { httpStatus: 403, message: '当前环境不允许启用开发身份模拟' },
  CONF_APPLY_FAILED: { httpStatus: 409, message: '配置生效校验失败，已回退上一有效版本' },
  CONF_PERSIST_FAILED: { httpStatus: 503, message: '配置持久化失败，请重试' },
  CONF_SECURITY_SWITCH_LOCKED: { httpStatus: 422, message: '安全开关为强制开启，不能关闭' },
  CONF_ENV_CONFLICT: { httpStatus: 422, message: '配置与当前运行环境冲突' },
  CONF_RUNTIME_MISMATCH: { httpStatus: 409, message: '保存值与运行值不一致' },
  CRAWL_DISABLED: { httpStatus: 409, message: '采集总开关已关闭' },
  CRAWL_PRECHECK_FAILED: { httpStatus: 422, message: '采集开启前置条件未满足' },
  CONF_CLIENT_BOOTSTRAP_UNAVAILABLE: { httpStatus: 503, message: '客户端引导信息暂不可用' },
  CONF_GATE_REPORT_MISSING: { httpStatus: 404, message: '尚无配置门禁扫描报告' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

export function httpStatusOf(code: string): number {
  return isErrorCode(code) ? ERROR_CODES[code].httpStatus : 500;
}

export function messageOf(code: string): string {
  return isErrorCode(code) ? ERROR_CODES[code].message : '服务暂时不可用';
}
