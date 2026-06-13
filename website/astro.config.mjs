// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://clankandslop.com',
  devToolbar: { enabled: false },
  // The /og/* routes exist only to be screenshotted into social cards — keep
  // them out of the sitemap (they also carry noindex).
  integrations: [sitemap({ filter: (page) => !page.includes('/og/') })],
});
