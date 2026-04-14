import { NextResponse } from 'next/server';
import { TEMPLATES } from '@/lib/templates';

export async function GET() {
  // Return templates without exposing server-side appIds
  return NextResponse.json({
    templates: TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
  });
}
