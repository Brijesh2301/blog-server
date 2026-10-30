import { v2 as cloudinary } from 'cloudinary'
import { env } from '../config/env.js'

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
})

export function uploadBuffer(buffer: Buffer, publicId: string): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ public_id: publicId, folder: 'blog', resource_type: 'image' }, (err, res) => {
        if (err || !res) return reject(err ?? new Error('Upload failed'))
        resolve({ url: res.secure_url })
      })
      .end(buffer)
  })
}