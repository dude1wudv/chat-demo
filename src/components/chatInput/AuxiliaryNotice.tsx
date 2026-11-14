import { useSettings } from '../../services/settings.js'
import type { ChatCapabilities } from '../../services/sub2apiBridgeContract.js'

export const AuxiliaryNotice = ({ caps, hasFiles }: { caps: ChatCapabilities; hasFiles: boolean }) => {
  const zh = useSettings((state) => state.locale === 'zh-CN')
  const labels: Record<string, string> = zh
    ? { search: '搜索', fetch: '链接阅读', image_search: '图片搜索', ocr: 'OCR', asr: '语音识别', tts: '朗读' }
    : { search: 'Search', fetch: 'URL reading', image_search: 'Image search', ocr: 'OCR', asr: 'Transcription', tts: 'Read aloud' }
  const units: Record<string, string> = zh ? { call: '次', page: '页', second: '秒', character: '计费字符' } : { call: 'calls', page: 'pages', second: 'seconds', character: 'billable characters' }
  const prices = caps.auxiliary_prices ?? []
  const ocr = prices.find((price) => price.kind === 'ocr')
  return <details>
    <summary>{zh ? '能力与费用' : 'Capabilities and pricing'}{hasFiles && caps.ocr && ocr ? ` · OCR ¥${ocr.unit_price}/${zh ? '页' : 'page'}` : ''}</summary>
    <small>
      <p>{zh ? '文本附件在本地服务端解码，不收解析费。PDF / Office / 无视觉能力模型的图片在发送后按需 OCR；上传本身不触发付费解析。OCR 只提取文字，不提供视觉理解。' : 'Text files are decoded on the server without parsing charges. Sending PDFs, Office documents or images to text-only models can start OCR. Uploading alone does not. OCR extracts text, not visual understanding.'}</p>
      {caps.native_files ? <p>{zh ? '当前使用对话账号的原生 Files，不走共享 OCR；未返回独立页数的解析费用由平台承担，不估算扣费。' : 'Native Files uses the conversation account, not shared OCR. Unreported standalone page charges are absorbed by the platform, never estimated.'}</p> : null}
      <p>{zh ? `搜索来源：${caps.search_source === 'native' ? '原生' : caps.search_source === 'shared' ? '共享辅助' : '不可用'}；链接阅读：${caps.read_url_source === 'native' ? '原生' : caps.read_url_source === 'shared' ? '共享辅助' : '不可用'}。` : `Search: ${caps.search_source ?? 'unavailable'}; URL reading: ${caps.read_url_source ?? 'unavailable'}.`}</p>
      {prices.length ? <>
        <p>{zh ? '辅助服务按下列人民币目录价数字 1:1 扣余额，不换汇、不叠加分组或用户倍率；对话 Token 另按所选分组计费。' : 'Auxiliary charges deduct the numeric CNY list price 1:1, without FX conversion or group/user multipliers. Conversation tokens retain their normal group pricing.'}</p>
        <ul>{prices.filter((price) => (price.kind !== 'ocr' || caps.ocr) && (!['asr', 'tts'].includes(price.kind) || caps.voice)).map((price) => <li key={price.kind}>{labels[price.kind] ?? price.kind}: ¥{price.unit_price} / {price.price_quantity} {units[price.unit] ?? price.unit}</li>)}</ul>
        <p>{zh ? 'ASR 按上游时长向上取整至秒；TTS 汉字计 2 字符、其他 Unicode 码点计 1。取消或断网不保证上游取消；结果不确定不会自动重试。' : 'ASR uses provider duration rounded up to seconds. TTS counts Han characters as two and other Unicode code points as one. Cancellation may not stop upstream work; uncertain outcomes are not automatically retried.'}</p>
      </> : <p>{zh ? '共享语音与 OCR 当前不可用。' : 'Shared speech and OCR are currently unavailable.'}</p>}
    </small>
  </details>
}
