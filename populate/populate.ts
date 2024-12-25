import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { DefaultJobQueuePlugin, DefaultSearchPlugin, bootstrapWorker, mergeConfig } from '@vendure/core';
import { EmailPlugin } from '@vendure/email-plugin';
import { performance } from 'perf_hooks';
import { config } from '../src/vendure-config';
import { ProductPopulator } from './productPopulate';

if (require.main === module) {
    run().then(
        () => process.exit(0),
        err => {
            console.log(err);
            process.exit(1);
        },
    );
}

async function run() {
    console.log(config);
    const start = performance.now();

    const { app } = await bootstrapWorker(config);
    const populator = new ProductPopulator(app);
    await populator.populate();
    const end = performance.now();
    console.log(`Populated products in ${(end - start) / 1000} seconds`);
}
