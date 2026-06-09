const CLOUD_DOC_WORDS = /(飞书\s*)?(云文档|飞书文档|飞书云文档|云空间|云盘)|feishu\s*(doc|docs|document)|lark\s*(doc|docs|document)/i;
const DOC_ACTION_WORDS = /(创建|新建|生成|保存|输出|导入|上传|转成|转换成|整理成|写成)/;
const DOC_TARGET_WORDS = /(飞书|云文档|飞书文档|飞书云文档|云空间|云盘|docx?|docs?|document)/i;

export function textRequestsCloudDocFolder(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (CLOUD_DOC_WORDS.test(clean)) return true;
  return DOC_ACTION_WORDS.test(clean) && DOC_TARGET_WORDS.test(clean);
}
