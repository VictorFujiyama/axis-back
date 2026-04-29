import { defineModule } from '@blossom/sdk';
import { registerCatalogRoutes } from './routes';

export default defineModule({
  key: 'catalog',
  name: 'Catálogo Everyday',
  description:
    'CRUD de produtos do catálogo: nome, marca, categoria, preço, descrição e imagem.',
  tabs: [
    { href: '/modules/catalog', label: 'Catálogo Everyday', icon: 'Package' },
  ],
  registerBackend: (app, ctx) => {
    registerCatalogRoutes(app);
    ctx.log.info('catalog module routes registered under /api/v1/modules/catalog');
  },
});
