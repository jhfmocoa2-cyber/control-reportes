import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://qdojbkoqyjxsgypocdhv.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkb2pia29xeWp4c2d5cG9jZGh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzE1ODQsImV4cCI6MjEwNjgwNzU4NH0.m2bHjrSLCWZ2UVNh9WXDqoCNIALKS7rxd-mJJUffpDc'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
