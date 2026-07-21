const { all, get, run, ensureHiddenSkuForProduct, deleteProductCascade } = require('../db');

async function getCategories(type) {
  return all('SELECT * FROM categories WHERE type = ? ORDER BY sort_order ASC, id ASC', [type]);
}

async function getCatalogFilters() {
  const [subjects, years, materialTypes] = await Promise.all([
    getCategories('subject'),
    getCategories('year'),
    getCategories('material_type'),
  ]);
  return { subjects, years, materialTypes };
}

async function listProducts() {
  return all(
    `SELECT *
     FROM products
     WHERE is_active = 1
     ORDER BY updated_at DESC, id DESC`
  );
}

async function getProductById(id, onlyActive = true) {
  return get(
    `SELECT *
     FROM products
     WHERE id = ? ${onlyActive ? 'AND is_active = 1' : ''}`,
    [id]
  );
}

async function getProductWithSkus(id, onlyActive = true) {
  const product = await getProductById(id, onlyActive);
  if (!product) return null;

  product.skus = await all(
    `SELECT *
     FROM skus
     WHERE product_id = ?
     ORDER BY is_active DESC, id ASC`,
    [id]
  );
  return product;
}

async function listProductsForAdmin() {
  return all(
    `SELECT *
     FROM products
     ORDER BY id DESC`
  );
}

async function createCategory({ name, type, sort_order }) {
  return run('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, ?)', [
    name,
    type,
    Number(sort_order || 0),
  ]);
}

async function deleteCategory(id) {
  return run('DELETE FROM categories WHERE id = ?', [id]);
}

async function upsertProduct(data, id = null) {
  const payload = {
    title: data.title || '',
    description: data.description || '',
    preview_text: data.preview_text || '',
    file_note: data.file_note || data.preview_text || '',
    detail_image: data.detail_image || '',
    delivery_text: data.delivery_text || '',
    price: Number(data.price || 0),
    subject_id: null,
    year_id: null,
    material_type_id: null,
    cover_image: data.cover_image || '',
    is_active: data.is_active ? 1 : 0,
  };

  if (id) {
    await run(
      `UPDATE products
       SET title = ?, description = ?, preview_text = ?, file_note = ?, delivery_text = ?, price = ?,
           detail_image = ?, subject_id = ?, year_id = ?, material_type_id = ?, cover_image = ?, is_active = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payload.title,
        payload.description,
        payload.preview_text,
        payload.file_note,
        payload.delivery_text,
        payload.price,
        payload.detail_image,
        payload.subject_id,
        payload.year_id,
        payload.material_type_id,
        payload.cover_image,
        payload.is_active,
        id,
      ]
    );

    const product = await getProductById(id, false);
    if (product) {
      await ensureHiddenSkuForProduct(product);
    }
    return { id };
  }

  const result = await run(
    `INSERT INTO products
     (title, description, preview_text, file_note, delivery_text, price, subject_id, year_id,
      detail_image, material_type_id, cover_image, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.title,
      payload.description,
      payload.preview_text,
      payload.file_note,
      payload.delivery_text,
      payload.price,
      payload.subject_id,
      payload.year_id,
      payload.detail_image,
      payload.material_type_id,
      payload.cover_image,
      payload.is_active,
    ]
  );

  const product = await getProductById(result.id, false);
  if (product) {
    await ensureHiddenSkuForProduct(product);
  }
  return result;
}

async function getDefaultSku(productId) {
  return get(
    `SELECT *
     FROM skus
     WHERE product_id = ? AND name = ?
     LIMIT 1`,
    [productId, '默认资料包']
  );
}

async function upsertSku(data, id = null) {
  const params = [
    data.product_id,
    data.name,
    Number(data.price || 0),
    data.delivery_url || '',
    data.access_code || '',
    data.is_active ? 1 : 0,
  ];

  if (id) {
    await run(
      `UPDATE skus SET product_id = ?, name = ?, price = ?, delivery_url = ?,
       access_code = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...params, id]
    );
    return { id };
  }

  return run(
    `INSERT INTO skus (product_id, name, price, delivery_url, access_code, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    params
  );
}

async function getSku(id) {
  return get(
    `SELECT s.*, p.title AS product_title FROM skus s
     JOIN products p ON p.id = s.product_id
     WHERE s.id = ?`,
    [id]
  );
}

async function deleteSku(id) {
  return run('DELETE FROM skus WHERE id = ?', [id]);
}

async function deleteProduct(id) {
  return deleteProductCascade(id);
}

module.exports = {
  getCategories,
  getCatalogFilters,
  listProducts,
  getProductById,
  getProductWithSkus,
  listProductsForAdmin,
  createCategory,
  deleteCategory,
  upsertProduct,
  getDefaultSku,
  upsertSku,
  getSku,
  deleteSku,
  deleteProduct,
};
