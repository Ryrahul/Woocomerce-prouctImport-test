import { Injectable, INestApplicationContext } from '@nestjs/common';
import {
    AssetService,
    ConfigService,
    FastImporterService,
    ID,
    LanguageCode,
    Logger,
    Product,
    ProductService,
    ProductVariantService,
    RequestContext,
    RequestContextService,
    SearchService,
    StockLocation,
    TaxCategory,
    TransactionalConnection,
    User,
    isGraphQlErrorResult,
    Asset,
} from '@vendure/core';
import WooCommerceRestApi from '@woocommerce/woocommerce-rest-api';
import { Readable } from 'stream';
import { IsNull } from 'typeorm';

@Injectable()
export class ProductPopulator {
    constructor(
        private app: INestApplicationContext,
        private assetService: AssetService,
        private connection: TransactionalConnection,
        private configService: ConfigService,
        private fastImporterService: FastImporterService,
        private searchService: SearchService,
    ) {}

    async populate() {
        const ctx = await this.getSuperadminContext();
        const api = new WooCommerceRestApi({
            url: 'https://naulokoseli.com',
            consumerKey: 'ck_57aa7580dc689050975eb07196ddfff6abb57ae8',
            consumerSecret: 'cs_65c2008af775be426eb89e140d4b83787e2c2a2f',
            version: 'wc/v3',
        });

        try {
            let page = 1;
            let allProducts: any[] = [];
            let products;

            // Fetch all products from WooCommerce
            do {
                console.time(`Page ${page}`);
                products = await api.get('products', {
                    per_page: 100,
                    page: page,
                });
                allProducts = [...allProducts, ...products.data];
                console.timeEnd(`Page ${page}`);
                page++;
            } while (products.data.length > 0);

            console.log(`Total products fetched: ${allProducts.length}`);

            // Get necessary entities
            const stockLocation = await this.getStockLocation(ctx);
            const defaultTaxCategory = await this.getDefaultTaxCategory(ctx);
            console.log(stockLocation);
            console.log(defaultTaxCategory);

            if (!stockLocation || !defaultTaxCategory) {
                throw new Error('Required entities not found');
            }

            // Process products in batches
            const batches = this.createBatches(allProducts, 10);
            let successCount = 0;
            let errorCount = 0;

            for (const batch of batches) {
                const results = await this.processBatch(ctx, batch, stockLocation, defaultTaxCategory);
                successCount += results.successCount;
                errorCount += results.errorCount;
            }

            // Reindex search after import
            await this.searchService.reindex(ctx);

            return { successCount, errorCount };
        } catch (error: any) {
            console.error('Error in product population:', error.response?.data || error.message);
            throw error;
        }
    }

    private createBatches<T>(data: T[], batchSize: number): T[][] {
        const batches: T[][] = [];
        for (let i = 0; i < data.length; i += batchSize) {
            batches.push(data.slice(i, i + batchSize));
        }
        return batches;
    }

    private async processBatch(
        ctx: RequestContext,
        products: any[],
        stockLocation: StockLocation,
        taxCategory: TaxCategory,
    ) {
        let successCount = 0;
        let errorCount = 0;
        let variableId: ID | undefined;

        for (const product of products) {
            try {
                // Check if product already exists
                const existingProduct = await this.connection.getRepository(ctx, Product).findOne({
                    where: {
                        deletedAt: IsNull(),
                        customFields: {
                            woocommerceId: product.id,
                        },
                    },
                });

                if (existingProduct) {
                    console.log(`Product already exists. WooCommerce ID: ${product.id}`);
                    successCount++;
                    continue;
                }

                // Process images
                const assets = await this.processImages(ctx, product.images);

                // Initialize fast importer
                await this.fastImporterService.initialize(ctx.channel);

                if (product.type === 'simple') {
                    await this.processSimpleProduct(ctx, product, assets, stockLocation, taxCategory);
                    variableId = undefined;
                } else if (product.type === 'variable') {
                    variableId = await this.processVariableProduct(ctx, product, assets);
                } else if (product.type === 'variation' && variableId) {
                    await this.processVariation(ctx, product, assets, variableId, stockLocation, taxCategory);
                }

                successCount++;
            } catch (error: any) {
                Logger.error(`Error processing product ${product.name}: ${error.message}`);
                errorCount++;
            }
        }

        return { successCount, errorCount };
    }

    private async processSimpleProduct(
        ctx: RequestContext,
        product: any,
        assets: Asset[],
        stockLocation: StockLocation,
        taxCategory: TaxCategory,
    ) {
        const { productId } = await this.createProduct(ctx, {
            name: product.name,
            slug: product.slug,
            description: product.description,
            wooCommerceId: product.id,
            assets,
        });

        await this.createVariant(ctx, {
            productId,
            name: product.name,
            description: product.description,
            stock: product.stock_quantity || 0,
            price: Math.round(parseFloat(product.price) * 100),
            weight: product.weight || 0,
            stockLocationId: stockLocation.id,
            taxCategoryId: taxCategory.id,
            assets,
        });
    }

    private async processVariableProduct(ctx: RequestContext, product: any, assets: Asset[]): Promise<ID> {
        const { productId } = await this.createProduct(ctx, {
            name: product.name,
            slug: product.slug,
            description: product.description,
            wooCommerceId: product.id,
            assets,
        });
        return productId;
    }

    private async processVariation(
        ctx: RequestContext,
        product: any,
        assets: Asset[],
        variableId: ID,
        stockLocation: StockLocation,
        taxCategory: TaxCategory,
    ) {
        await this.createVariant(ctx, {
            productId: variableId,
            name: product.name,
            description: product.description,
            stock: product.stock_quantity || 0,
            price: Math.round(parseFloat(product.price) * 100),
            weight: product.weight || 0,
            stockLocationId: stockLocation.id,
            taxCategoryId: taxCategory.id,
            assets,
        });
    }

    private async createProduct(
        ctx: RequestContext,
        input: {
            name: string;
            slug: string;
            description: string;
            wooCommerceId: string;
            assets: Asset[];
        },
    ) {
        const productId = await this.fastImporterService.createProduct({
            enabled: true,
            assetIds: input.assets.map(asset => asset.id),
            featuredAssetId: input.assets[0]?.id,
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: input.name,
                    slug: input.slug,
                    description: input.description,
                },
            ],
            customFields: {
                woocommerceId: input.wooCommerceId,
            },
        });

        return { productId };
    }

    private async createVariant(
        ctx: RequestContext,
        input: {
            productId: ID;
            name: string;
            description: string;
            stock: number;
            price: number;
            weight: number;
            stockLocationId: ID;
            taxCategoryId: ID;
            assets: Asset[];
        },
    ) {
        return this.fastImporterService.createProductVariant({
            productId: input.productId,
            sku: `${input.name}-${Date.now()}`,
            stockOnHand: input.stock,
            price: input.price,
            taxCategoryId: input.taxCategoryId,
            assetIds: input.assets.map(asset => asset.id),
            featuredAssetId: input.assets[0]?.id,
            stockLevels: [
                {
                    stockOnHand: input.stock,
                    stockLocationId: input.stockLocationId,
                },
            ],
            customFields: {
                weight: input.weight,
            },
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: input.name,
                },
            ],
        });
    }

    private async processImages(ctx: RequestContext, images: any[]): Promise<Asset[]> {
        const assets: Asset[] = [];
        for (const image of images) {
            try {
                const asset = await this.uploadImage(ctx, image.src);
                if (asset) {
                    const assetWithChannels = await this.connection.getRepository(ctx, Asset).findOne({
                        where: { id: asset.id },
                        relations: ['channels'],
                    });
                    if (assetWithChannels) {
                        assets.push(assetWithChannels);
                    }
                }
            } catch (error) {
                Logger.error(`Failed to process image: ${error}`);
            }
        }
        return assets;
    }

    private async uploadImage(ctx: RequestContext, url?: string): Promise<Asset | null> {
        try {
            if (!url) return null;

            const res = await fetch(url);
            if (!res.ok) {
                Logger.warn('Failed to fetch image');
                return null;
            }

            const reader = res.body!.getReader();
            const chunks: Uint8Array[] = [];
            let done = false;

            while (!done) {
                const { value, done: doneReading } = await reader.read();
                done = doneReading;
                if (value) {
                    chunks.push(value);
                }
            }

            const buffer = Buffer.concat(chunks);
            const readable = new Readable();
            readable.push(buffer);
            readable.push(null);

            const asset = await this.assetService.createFromFileStream(readable, `${Date.now()}.jpeg`, ctx);

            if (isGraphQlErrorResult(asset)) {
                return null;
            }

            return this.connection.getRepository(ctx, Asset).findOne({
                where: { id: asset.id },
                relations: ['channels'],
            });
        } catch (error) {
            Logger.error(`Error uploading image: ${error}`);
            return null;
        }
    }

    private async getStockLocation(ctx: RequestContext): Promise<StockLocation | null> {
        return this.connection.getRepository(ctx, StockLocation).findOne({
            where: {
                channels: {
                    id: ctx.channelId,
                },
            },
        });
    }

    private async getDefaultTaxCategory(ctx: RequestContext): Promise<TaxCategory | null> {
        return this.connection.getRepository(ctx, TaxCategory).findOne({
            where: {
                isDefault: true,
            },
        });
    }

    private async getSuperadminContext(): Promise<RequestContext> {
        const { superadminCredentials } = this.configService.authOptions;
        const superAdminUser = await this.connection.getRepository(User).findOneOrFail({
            where: {
                identifier: superadminCredentials.identifier,
            },
        });

        return this.app.get(RequestContextService).create({
            apiType: 'admin',
            user: superAdminUser,
        });
    }
}
