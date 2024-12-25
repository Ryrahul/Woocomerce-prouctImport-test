import { INestApplicationContext } from '@nestjs/common';
import {
    ConfigService,
    ID,
    LanguageCode,
    ProductService,
    ProductVariantService,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    User,
} from '@vendure/core';
import WooCommerceRestApi from '@woocommerce/woocommerce-rest-api';

export class ProductPopulator {
    private productService: ProductService;
    private productVariantService: ProductVariantService;
    private app: INestApplicationContext;

    constructor(app: INestApplicationContext) {
        this.productService = app.get(ProductService);
        this.productVariantService = app.get(ProductVariantService);
        this.app = app;
    }

    async populate() {
        const ctx = await this.getSuperadminContext(this.app);
        const api = new WooCommerceRestApi({
            url: process.env.API_URL!,
            consumerKey: process.env.CONSUMER_KEY!,
            consumerSecret: process.env.CONSUMER_SECRET!,
            version: 'wc/v3',
        });

        try {
            let page = 1;
            let allProducts: any[] = [];
            let products;

            do {
                console.time(page.toString());
                products = await api.get('products', {
                    per_page: 100,
                    page: page,
                });
                allProducts = [...allProducts, ...products.data];
                console.timeEnd(page.toString());
                page++;
            } while (products.data.length > 0);

            console.log(`Total products fetched: ${allProducts.length}`);
            const batches = this.createBatches(allProducts, 10);
            for (const batch of batches) {
                await this.processBatch(ctx, batch);
            }
        } catch (error: any) {
            console.error(
                'Error fetching or processing WooCommerce data:',
                error.response?.data || error.message,
            );
        }
    }

    createBatches<T>(data: T[], batchSize: number): T[][] {
        const batches: T[][] = [];
        for (let i = 0; i < data.length; i += batchSize) {
            batches.push(data.slice(i, i + batchSize));
        }
        return batches;
    }

    async processBatch(ctx: RequestContext, batch: any[]) {
        for (const product of batch) {
            console.log(`Processing product: ${product.name}`);
            try {
                const productResult = await this.createOrUpdateProduct(ctx, product);

                if (product.variations && product.variations.length > 0) {
                    console.log(`Creating variants for product: ${product.name}`);
                    await this.createVariants(ctx, productResult.id, product);
                } else {
                    console.log(`Creating default variant for product: ${product.name}`);
                    await this.createDefaultVariant(ctx, productResult.id, product);
                }
            } catch (error: any) {
                console.error(`Error processing product ${product.name}:`, error.message);
            }
        }
    }

    async createOrUpdateProduct(ctx: RequestContext, product: any) {
        const createdProduct = await this.productService.create(ctx, {
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: product.name,
                    description: product.description || '',
                    slug: product.slug,
                },
            ],
        });

        return createdProduct;
    }

    async createVariants(ctx: RequestContext, productId: ID, product: any) {
        const existingVariants = await this.productVariantService.findAll(ctx, {
            filter: {
                productId: { eq: String(productId) },
            },
        });

        const variants = existingVariants.items;
        const productPrice = parseFloat(product.price) * 100;

        if (isNaN(productPrice) || productPrice <= 0) {
            console.warn(
                `Invalid price for product ${product.name}. Setting price to 0. Price received:`,
                product.price,
            );
        }

        for (const variation of product.variations) {
            try {
                let variantAttributes = product.attributes
                    ? product.attributes.map((attr: any) => ({
                          name: attr.name,
                          value:
                              variation.attributes && variation.attributes[attr.name]
                                  ? variation.attributes[attr.name]
                                  : 'default',
                      }))
                    : [];

                let sku = variation.sku || `${product.sku}-${Date.now()}`;

                const combinationExists = variants.some((variant: any) => {
                    return variant.attributes.every((attribute: any) => {
                        return variantAttributes.some(
                            (va: any) => va.name === attribute.name && va.value === attribute.value,
                        );
                    });
                });

                if (combinationExists) {
                    console.log(
                        `Combination already exists for ${product.name}, generating a new unique variant...`,
                    );

                    variantAttributes = variantAttributes.map((attr: any) => ({
                        ...attr,
                        value: `${attr.value}-${Date.now()}`,
                    }));

                    sku = `${sku}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
                }

                const price = productPrice;

                const createdVariant = await this.productVariantService.create(ctx, [
                    {
                        productId,
                        sku,
                        price: price,
                        stockOnHand: variation.stock_quantity || 0,
                        translations: [
                            {
                                languageCode: LanguageCode.en,
                                name: `${product.name} - ${variantAttributes.map((a: any) => a.value).join(', ')}`,
                            },
                        ],
                    },
                ]);

                console.log(`Variant created: ${createdVariant[0].id}`);
            } catch (error: any) {
                console.error(`Error creating variant for product ${product.name}:`, error.message);
            }
        }
    }

    async createDefaultVariant(ctx: RequestContext, productId: ID, product: any) {
        const productPrice = parseFloat(product.price) * 100;

        const defaultSku = product.sku || `${product.name}-${Date.now()}`;

        const createdVariant = await this.productVariantService.create(ctx, [
            {
                productId,
                sku: defaultSku,
                price: productPrice,
                stockOnHand: product.stock_quantity || 0,
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: `${product.name} - Default Variant`,
                    },
                ],
            },
        ]);

        console.log(
            `Default variant created for product: ${product.name}, Variant ID: ${createdVariant[0].id}`,
        );
    }

    async getSuperadminContext(app: INestApplicationContext): Promise<RequestContext> {
        const { superadminCredentials } = app.get(ConfigService).authOptions;
        const superAdminUser = await app
            .get(TransactionalConnection)
            .getRepository(User)
            .findOneOrFail({ where: { identifier: superadminCredentials.identifier } });
        return app.get(RequestContextService).create({
            apiType: 'admin',
            user: superAdminUser,
        });
    }
}
