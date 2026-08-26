import { NextRequest, NextResponse } from 'next/server';
import { findSiteByName } from '@/lib/registry';

// Warn the user before they create a second site with the same name.
//
// This checks our registry, not Cloudways. Cloudways ignores the label we pass
// when cloning and names every clone "Cloned-<template label>", so the old
// lookup — find an app whose label matches the slugified name — could never
// match and silently always reported "no duplicate".

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ exists: false });

  try {
    const site = await findSiteByName(name);
    if (site) {
      return NextResponse.json({
        exists: true,
        url: site.siteUrl,
        createdAt: site.createdAt,
        stillOnCloudways: site.liveOnCloudways,
      });
    }
    return NextResponse.json({ exists: false });
  } catch {
    // A failed check must not block the user from creating a site.
    return NextResponse.json({ exists: false });
  }
}
