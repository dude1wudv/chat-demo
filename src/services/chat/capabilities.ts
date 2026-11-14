import type { ChatCapabilities } from '../sub2apiBridgeContract.js'
const OCR_IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']

export const acceptsChatAttachment = (caps: ChatCapabilities, name: string, image: boolean): boolean => {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (image) return caps.image_input || (caps.ocr === true && OCR_IMAGES.includes(extension))
  if (!caps.document_input) return false
  return caps.accepted_document_extensions?.includes(extension) ?? caps.native_files
}

export const chatAttachmentAccept = (caps: ChatCapabilities | undefined): string => {
  if (!caps) return ''
  const extensions = caps.accepted_document_extensions ?? []
  const images = caps.image_input ? ['image/*'] : caps.ocr ? OCR_IMAGES.map((extension) => `.${extension}`) : []
  return [...extensions.map((extension) => `.${extension}`), ...images].join(',')
}
