import { createClient } from '@supabase/supabase-js'

function getCleanUrl() {
  let url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/^["']|["']$/g, '')
  
  if (!url) {
    return 'https://qdojbkoqyjxsgypocdhv.supabase.co'
  }
  
  // Si pegaron solo el ID sin https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (!url.includes('.')) {
      return `https://${url}.supabase.co`
    }
    url = `https://${url}`
  }
  
  // Quitar sufijo /rest/v1 o barras finales si las tiene
  return url.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')
}

function getCleanKey() {
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!key) {
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkb2pia29xeWp4c2d5cG9jZGh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzE1ODQsImV4cCI6MjEwNjgwNzU4NH0.m2bHjrSLCWZ2UVNh9WXDqoCNIALKS7rxd-mJJUffpDc'
  }
  return key
}

export const supabase = createClient(getCleanUrl(), getCleanKey())
