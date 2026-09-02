(function () {
  function formatNumber(value, locale, options = {}) {
    const safeLocale = locale || "en";
    const numericValue = Number(value ?? 0);
    return new Intl.NumberFormat(safeLocale, options).format(numericValue);
  }

  function formatDate(value, locale, options = {}) {
    const safeLocale = locale || "en";
    const date = value ? new Date(value) : new Date();
    return new Intl.DateTimeFormat(safeLocale, options).format(date);
  }

  function formatCurrency(value, locale, currency = "EUR", options = {}) {
    const safeLocale = locale || "en";
    return new Intl.NumberFormat(safeLocale, {
      style: "currency",
      currency,
      ...options,
    }).format(Number(value ?? 0));
  }

  window.watcharrI18nFormatters = {
    formatNumber,
    formatDate,
    formatCurrency,
  };

  window.i18n = window.i18n || {};
  window.i18n.formatters = window.watcharrI18nFormatters;
})();
