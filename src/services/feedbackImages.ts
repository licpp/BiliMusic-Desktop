export const FEEDBACK_IMAGE_MAX_COUNT = 3
export const FEEDBACK_IMAGE_MAX_BYTES = 2 * 1024 * 1024
export const FEEDBACK_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'

type FeedbackImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

export interface FeedbackImage {
  name: string
  mimeType: FeedbackImageMime
  base64: string
}

export function feedbackClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files).filter(file => file.type.startsWith('image/') ||
    (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name)))
  if (files.length) return files
  const images: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) images.push(file)
  }
  return images
}

export function feedbackImagePreview(image: FeedbackImage): string {
  return `data:${image.mimeType};base64,${image.base64}`
}

function detectImageType(bytes: Uint8Array): FeedbackImageMime | undefined {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte)

  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return undefined
}

function readImageBytes(file: File): Promise<Uint8Array> {
  // FileReader also works in the older Android WebViews used by the car app.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer && reader.result.byteLength === file.size) {
        resolve(new Uint8Array(reader.result))
      } else {
        reject(new Error('Invalid image read'))
      }
    }
    reader.onerror = reader.onabort = () => reject(new Error('Image read failed'))
    reader.readAsArrayBuffer(file)
  })
}

function encodeImageBytes(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 16 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

export async function readFeedbackImages(files: ArrayLike<File>, existingCount = 0): Promise<{
  images: FeedbackImage[]
  errors: string[]
}> {
  const images: FeedbackImage[] = []
  const errors: string[] = []

  for (let index = 0; index < files.length; index += 1) {
    if (existingCount + images.length >= FEEDBACK_IMAGE_MAX_COUNT) {
      errors.push(`最多添加 ${FEEDBACK_IMAGE_MAX_COUNT} 张图片`)
      break
    }

    const file = files[index]
    const name = file.name.replace(/[\\/\x00-\x1f\x7f]/g, '').trim().slice(0, 120) || '图片'
    if (file.size > FEEDBACK_IMAGE_MAX_BYTES) {
      errors.push(`${name} 超过 2 MB`)
      continue
    }

    try {
      const bytes = await readImageBytes(file)
      const mimeType = detectImageType(bytes)
      if (mimeType) {
        images.push({name, mimeType, base64: encodeImageBytes(bytes)})
      } else {
        errors.push(`${name} 不支持，请使用 JPG、PNG 或 WebP 图片`)
      }
    } catch {
      errors.push(`无法读取 ${name}，请重试`)
    }
  }

  return {images, errors}
}
