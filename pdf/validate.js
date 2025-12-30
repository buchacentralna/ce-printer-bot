export function validateFile(file) {
  const allowed = [
    'application/pdf',
    'image/jpeg',
    'image/png'
  ]

  return allowed.includes(file.mime_type)
}
