import { File, FileCode, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import type { Attachment } from '../../types'

/** 按附件类型给图标：输入框和消息里的附件卡片共用同一套。 */
export function AttachmentIcon({ kind, size }: { kind: Attachment['kind']; size: number }) {
  switch (kind) {
    case 'sheet':
      return <FileSpreadsheet size={size} />
    case 'slide':
      return <Presentation size={size} />
    case 'text':
      return <FileCode size={size} />
    case 'pdf':
    case 'docx':
      return <FileText size={size} />
    default:
      // 解析不了的类型用空白文件图标，跟能读的区分开。
      return <File size={size} />
  }
}
