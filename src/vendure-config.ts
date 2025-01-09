import {
    dummyPaymentHandler,
    DefaultJobQueuePlugin,
    DefaultSearchPlugin,
    VendureConfig,
    DefaultAssetNamingStrategy,
} from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin } from '@vendure/email-plugin';
import { AssetServerPlugin, configureS3AssetStorage } from '@vendure/asset-server-plugin';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import 'dotenv/config';
import { customAdminUi } from './custom-admin-ui/compile-admin-ui';

import path from 'path';

const IS_DEV = process.env.APP_ENV === 'dev';
const UI_DEV = process.env.UI_ENV === 'dev';

export const config: VendureConfig = {
    apiOptions: {
        port: 3000,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        adminListQueryLimit: Number.MAX_SAFE_INTEGER,

        adminApiPlayground: {
            settings: { 'request.credentials': 'include' },
        },
        adminApiDebug: true,
        shopApiPlayground: {
            settings: { 'request.credentials': 'include' },
        },
        shopApiDebug: true,
        cors: {
            origin: '*',
            methods: 'GET,PUT,PATCH,POST,DELETE',
            credentials: true,
        },
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: {
            identifier: 'superadmin',
            password: 'superadmin',
        },
        cookieOptions: {
            secret: process.env.COOKIE_SECRET,
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        synchronize: true,
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: 'wordpress',
        schema: 'public',
        host: 'localhost',
        port: +Number(process.env.DB_PORT) || 5432,
        username: 'postgres',
        password: 'postgres',
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
    customFields: {
        Product: [
            {
                name: 'woocommerceId',
                type: 'string',
            },
        ],
    },
    plugins: [
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, '../static/assets'),
            namingStrategy: new DefaultAssetNamingStrategy(),

            // storageStrategyFactory: !IS_DEV
            //     ? configureS3AssetStorage({
            //           bucket: String(process.env.AWS_BUCKET),
            //           credentials: {
            //               accessKeyId: String(process.env.AWS_ACCESS_KEY_ID),
            //               secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY),
            //           },
            //           nativeS3Configuration: {
            //               endpoint: String(process.env.AWS_ENDPOINT),
            //               s3ForcePathStyle: true,
            //               region: String(process.env.AWS_REGION),
            //           },
            //       })
            //     : undefined,
            assetUrlPrefix: !IS_DEV ? `http://localhost:3000/assets/` : undefined,
        }),

        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            devMode: true,
            outputPath: path.join(__dirname, '../static/email/test-emails'),
            route: 'mailbox',
            handlers: defaultEmailHandlers,
            templatePath: path.join(__dirname, '../static/email/templates'),
            globalTemplateVars: {
                // The following variables will change depending on your storefront implementation.
                // Here we are assuming a storefront running at http://localhost:8080.
                fromAddress: '"example" <noreply@example.com>',
                verifyEmailAddressUrl: 'http://localhost:8080/verify',
                passwordResetUrl: 'http://localhost:8080/password-reset',
                changeEmailAddressUrl: 'http://localhost:8080/verify-email-address-change',
            },
        }),
        AdminUiPlugin.init({
            route: 'admin',
            port: 3002,
            app: customAdminUi({ devMode: UI_DEV, recompile: UI_DEV }),
        }),
    ],
};
