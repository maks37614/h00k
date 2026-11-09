import express, { type Express } from 'express';
import path from 'node:path';

/** Hashed bundles are immutable. Missing bundles must never receive SPA HTML. */
export function installProductionAssets(app: Express, distPath: string): void {
  app.use('/assets', express.static(path.join(distPath, 'assets'), {
    immutable: true, maxAge: '1y',
  }));
  app.use('/assets', (_req, res) => {
    res.status(404).type('text/plain').send('Asset not found');
  });
  app.use(express.static(distPath, { index: false }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
