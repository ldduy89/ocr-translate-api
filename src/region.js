// Trả về mã quốc gia nếu yêu cầu đến từ khu vực bị chặn, ngược lại trả null.
// Không có header quốc gia (server không đứng sau Cloudflare...) thì không chặn được: coi như cho qua.
export function blockedCountry(headers, cfg) {
  const cc = String(headers[cfg.countryHeader] || '').trim().toUpperCase();
  return cc && cfg.blockedCountries.has(cc) ? cc : null;
}
