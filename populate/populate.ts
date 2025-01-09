import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import {
    DefaultJobQueuePlugin,
    DefaultSearchPlugin,
    bootstrapWorker,
    AssetService,
    ConfigService,
    FastImporterService,
    SearchService,
    TransactionalConnection,
} from '@vendure/core';
import { EmailPlugin } from '@vendure/email-plugin';
import { performance } from 'perf_hooks';
import { config } from '../src/vendure-config';
import { ProductPopulator } from './productPopulate';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';

if (require.main === module) {
    run().then(
        () => process.exit(0),
        err => {
            console.error('Error during population:', err);
            process.exit(1);
        },
    );
}

async function run() {
    try {
        console.log('Starting product population with config:', config);
        const start = performance.now();

        const { app } = await bootstrapWorker({
            ...config,
        });

        const assetService = app.get(AssetService);
        const connection = app.get(TransactionalConnection);
        const configService = app.get(ConfigService);
        const fastImporterService = app.get(FastImporterService);
        const searchService = app.get(SearchService);

        const populator = new ProductPopulator(
            app,
            assetService,
            connection,
            configService,
            fastImporterService,
            searchService,
        );

        const result = await populator.populate();

        const end = performance.now();
        const duration = (end - start) / 1000;

        console.log(`Population completed in ${duration} seconds`);
        console.log(`Successfully imported: ${result.successCount} products`);
        console.log(`Failed to import: ${result.errorCount} products`);
    } catch (error) {
        console.error('Fatal error during population:', error);
        throw error;
    }
}
