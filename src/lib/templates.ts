export interface SiteTemplate {
  id: string;
  name: string;
  description: string;
  appId: string;
  wpUrl: string;
}

export const TEMPLATES: SiteTemplate[] = [
  {
    id: 'standard',
    name: 'WP Standard',
    description: 'General-purpose WordPress site',
    appId: process.env.CLOUDWAYS_TEMPLATE_APP_ID ?? '',
    wpUrl: process.env.TEMPLATE_WP_URL ?? '',
  },
  {
    id: 'tradie',
    name: 'WP Tradie',
    description: 'Trades & services businesses',
    appId: '6226628',
    wpUrl: 'https://wordpress-1453465-6226628.cloudwaysapps.com',
  },
  {
    id: 'finance',
    name: 'WP Finance',
    description: 'Finance & professional services',
    appId: '6182784',
    wpUrl: 'https://wordpress-1453465-6182784.cloudwaysapps.com',
  },
];

export function getTemplate(id: string): SiteTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
