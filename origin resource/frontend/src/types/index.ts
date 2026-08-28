/** 本文件描述前后端交换的数据形状。接口字段改变时，应首先同步这里。 */
export type Role = 'user' | 'assistant'

/** 用户随消息上传的文件。文档正文会由后端解析后放入 text_content。 */
export interface Attachment {
  id: string
  name: string
  kind: 'image' | 'pdf' | 'docx' | 'sheet' | 'slide' | 'text' | 'file'
  stored_name?: string
  size?: number
  preview?: string | null
  text_content?: string | null
}

/** 联网搜索实际打开过的页面。来源列表以此为准，而非正文里的链接。 */
export interface SearchSource {
  url: string
  host: string
}

/** 工具执行过程中的一步，用于在气泡里显示「正在搜索…／正在阅读…」。 */
export interface ToolProgress {
  action: 'search' | 'open_page'
  url: string
  queries: string[]
}

/** 代码执行等待用户确认。后端此时停在原地，必须答复或等它超时。 */
export interface CodeExecRequest {
  request_id: string
  code: string
  purpose: string
  /** 静态检查认出来的导入模块，展示给用户判断这段代码要碰什么。 */
  modules: string[]
  conversation_id: string
  timeout_seconds: number
}

/** 一次工具调用的完整记录。会随消息存库，重开对话时还原气泡。 */
export interface ToolCall {
  call_id: string
  tool: string
  arguments: Record<string, unknown>
  /**
   * 成功时的展示数据。各工具用到的字段不同：
   * 联网搜索为 { text, sources, usage }，长期记忆为 { text, duplicate }。
   */
  display?: {
    text?: string
    sources?: SearchSource[]
    usage?: Record<string, number>
    /** 长期记忆：内容与已有记忆重复，没有新写入。 */
    duplicate?: boolean
    /** 代码执行：实际跑的代码与它的输出。 */
    code?: string
    stdout?: string
    stderr?: string
    timed_out?: boolean
    elapsed_ms?: number
    returncode?: number | null
  }
  error?: string
  // 以下字段只在流式过程中存在，不会存入数据库。
  running?: boolean
  progress?: ToolProgress[]
  /** 代码执行：正在等用户确认，或已确认正在跑。 */
  awaitingConfirm?: boolean
}

export interface Message {
  id: string
  parent_id: string | null
  role: Role
  content: string
  thinking?: string | null
  model?: string | null
  attachments: Attachment[]
  tool_calls?: ToolCall[]
  created_at: string
  // 以下字段只服务于前端动画，不会存入数据库。
  streaming?: boolean
  thinkingOpen?: boolean
}

/** 项目：一组共享专属指令的会话。 */
export interface Project {
  id: string
  name: string
  description: string
  /** 项目级系统指令，追加在全局系统提示词之后。 */
  instructions: string
  created_at: string
  updated_at: string
  /** 列表接口附带的归属会话数量；单个项目详情里没有这个字段。 */
  conversation_count?: number
}

/** 回答风格。builtin 的条目可以改措辞但不能删。 */
export interface ChatStyle {
  id: string
  name: string
  prompt: string
  builtin?: boolean
}

export interface ConversationMeta {
  id: string
  title: string
  created_at: string
  updated_at: string
  pinned: number
  project_id: string | null
  style_id: string | null
}

/** 正文搜索的一条命中：每个会话只回最近一条，附该会话命中总数。 */
export interface MessageSearchHit {
  conversation_id: string
  title: string
  project_id: string | null
  updated_at: string
  message_id: string
  role: string
  match_count: number
  snippet: string
}

export interface ConversationTree {
  id: string
  title: string
  created_at: string
  updated_at: string
  /** 当前显示分支的最后一条消息；通过 parent_id 可以一路回溯到开头。 */
  active_leaf_id: string | null
  project_id: string | null
  style_id: string | null
  /** 这段对话要不要带长期记忆。新会话一律为 false，由用户在输入框上打开。 */
  memory_enabled: boolean
  /** 勾选了哪几条记忆的 id。开关开着但数组为空 = 一条都不带。 */
  memory_ids: string[]
  messages: Message[]
}

/** 一条长期记忆：跨会话保留，每轮都会拼进系统提示词。 */
export interface Memory {
  id: string
  content: string
  /** 由模型写入时记下来自哪次对话；用户手工添加的为 null。 */
  source_conversation_id: string | null
  created_at: string
  updated_at: string
}

export interface MemoryList {
  items: Memory[]
  /** 渲染后的记忆块字符数，用来告诉用户这部分每轮占多少上下文。 */
  block_chars: number
}

/** 一套联网搜索的上游配置。可以存多套，同一时刻只有一套生效。 */
export interface SearchProvider {
  id: string
  /** 显示用的名字，例如「DeepSeek 官方」「某中转站」。 */
  name: string
  base_url: string
  api_key: string
  model: string
  /** 单次搜索的输出预算。搜索结果由服务端塞进上下文，输入量远大于普通对话。 */
  max_output_tokens: number
}

/** 设置页「检测」按钮拿到的报告。ok 为真才代表真的能联网检索。 */
export interface SearchTestResult {
  ok: boolean
  /** ok=能用；no_sources=能出字但没执行搜索；error=请求失败。 */
  status: 'ok' | 'no_sources' | 'error'
  message: string
  /** 实际命中的接口地址，用来确认自动容错选中了哪条路径。 */
  endpoint: string
  elapsed_ms: number
  sources: { url: string; host: string }[]
  text: string
  tool_calls: number
  http_status?: number
}

/** 「检测可用模型」拿到的清单。只读上游的 /models，不产生调用费用。 */
export interface ModelListResult {
  ok: boolean
  message: string
  /** 实际命中的接口地址，用来确认自动容错选中了哪条路径。 */
  endpoint: string
  models: string[]
  elapsed_ms: number
  http_status?: number
}

/** 单个模型的可用性测试结果。清单里有不等于调得动，所以要单独验。 */
export interface ModelTestResult {
  ok: boolean
  message: string
  elapsed_ms: number
  /** 模型回的第一句，用来肉眼确认确实是它在答。 */
  reply: string
  http_status?: number
}

export interface Settings {
  base_url: string
  api_key: string
  models: string[]
  default_model: string
  system_prompt: string
  temperature: number
  max_tokens: number
  /** 默认思考档位：auto 表示不向上游发 reasoning_effort。 */
  default_thinking: string
  theme: 'light' | 'dark'
  /**
   * 图片渠道 1.2.19 起并进桌面端的「多 API」，这里不再有 image_providers。
   * 下面三个字段由桌面层在发图片请求前后临时改写，**不是配置入口**，
   * 界面上也不要展示它们（会一直是空的）。
   */
  image_base_url: string
  image_api_key: string
  image_model: string
  image_size: string
  image_quality: string
  /** 是否把工具（目前只有联网搜索）声明给模型。 */
  tools_enabled: boolean
  /** 搜索走独立上游，可以存多套（官方直连 / 各家中转站）随时切换。 */
  search_providers: SearchProvider[]
  /** 当前正在使用的那套搜索配置的 id。 */
  search_provider_id: string
  /** 上下文超限时自动把靠前历史压缩成摘要。 */
  context_auto_compact: boolean
  /** 上下文预算（按字符估算）。 */
  context_max_chars: number
  /** 达到预算的百分之多少时触发压缩。 */
  context_compact_trigger_percent: number
  /** 压缩时至少保留多少字符的最近原文。 */
  context_keep_recent_chars: number
  /** 单个附件的体积上限（MB）。 */
  single_file_max_mb: number
  /** 单个附件解析后送给模型的字符上限。 */
  single_file_max_chars: number
  /** 一条消息内所有附件的体积上限（MB）。 */
  message_files_max_mb: number
  /** 一条消息内所有附件正文合计的字符上限。 */
  message_files_max_chars: number
  /** 全部回答风格，含内置项。 */
  styles: ChatStyle[]
  /** 会话没单独指定风格时使用的风格 id。 */
  default_style_id: string
  /** 是否把长期记忆拼进系统提示词。关掉后已存的记忆保留但不生效。 */
  memory_enabled: boolean
  /** 是否允许模型主动调用 remember 工具写入记忆。 */
  memory_auto_capture: boolean
  /** 最多保留多少条记忆，超出淘汰最旧的。 */
  memory_max_items: number
  /** 记忆块的字符上限，它每轮都要重发。 */
  memory_max_chars: number
  /** 提示词模板，只填进输入框，不进系统提示词。 */
  prompt_templates: PromptTemplate[]
  /** 是否允许模型在本机执行 Python。开启后每次执行仍要用户确认。 */
  code_exec_enabled: boolean
}

/** 一条提示词模板。正文里的 {{input}} 会被输入框已有的文字替换。 */
export interface PromptTemplate {
  id: string
  name: string
  content: string
}

/** 后端压缩上下文后通过 SSE 回传的提示信息。 */
export interface ContextCompactInfo {
  compacted: boolean
  summary_count: number
  dropped_messages: number
  before_chars: number
  after_chars: number
  error?: string | null
}

export type AppMode = 'chat' | 'image'

/** 一次图片生成或编辑任务的历史记录。files 可包含多张结果图。 */
export interface ImageRecord {
  id: string
  mode: 'generate' | 'edit'
  prompt: string
  negative_prompt: string
  model: string
  size: string
  quality: string
  source_image_name: string
  /** 参考图的原始文件名，仅 edit 模式可能有值。 */
  reference_names?: string[]
  /** 与 reference_names 一一对应的「要参考什么特征」说明。 */
  reference_notes?: string[]
  files: string[]
  created_at: string
}
