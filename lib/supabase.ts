import { createClient } from '@supabase/supabase-js'

const DEFAULT_URL = 'https://qdojbkoqyjxsgypocdhv.supabase.co'
const DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkb2pia29xeWp4c2d5cG9jZGh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzE1ODQsImV4cCI6MjEwNjgwNzU4NH0.m2bHjrSLCWZ2UVNh9WXDqoCNIALKS7rxd-mJJUffpDc'

function getValidUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const match = raw.match(/https:\/\/[a-zA-Z0-9_-]+\.supabase\.co/i)
  if (match) return match[0]
  return DEFAULT_URL
}

function getValidKey(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  const match = raw.match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/)
  if (match) return match[0]
  return DEFAULT_KEY
}

export const supabase = createClient(getValidUrl(), getValidKey())
