import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { ApiError, agentErrorMessage } from "./api";

export type Locale = "zh-CN" | "en";
export type LocalizedError = [cause: unknown, zhFallback: string, enFallback: string];
export type LocalizedNotice = [zh: string, en: string] | LocalizedError;
export type Translate = (zh: string, en: string) => string;

const preferenceKey = "ocf-locale";

function readLocale(): Locale {
  try { return localStorage.getItem(preferenceKey) === "en" ? "en" : "zh-CN"; }
  catch { return "zh-CN"; }
}

function localeTools(locale: Locale) {
  const t: Translate = (zh, en) => locale === "en" ? en : zh;

  function errorText(...[cause, zhFallback, enFallback]: LocalizedError): string {
    if (cause instanceof ApiError) {
      const message = agentErrorMessage(cause.code, locale);
      return message === cause.code && locale === "en" ? enFallback : message;
    }
    if (cause instanceof Error && !(cause instanceof TypeError) && cause.message &&
        (locale === "zh-CN" || !/\p{Script=Han}/u.test(cause.message))) return cause.message;
    return t(zhFallback, enFallback);
  }

  return {
    t,
    errorText,
    noticeText: (notice: LocalizedNotice) => notice.length === 2 ? t(...notice) : errorText(...notice),
  };
}

const LocaleContext = createContext({
  locale: "zh-CN" as Locale,
  setLocale: (_locale: Locale) => {},
  ...localeTools("zh-CN"),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(readLocale);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem(preferenceKey, locale); }
    catch { /* Language switching also works without persistent storage. */ }
  }, [locale]);
  return <LocaleContext.Provider value={{ locale, setLocale, ...localeTools(locale) }}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function formatCalendarDate(date: string, locale: Locale): string {
  const value = new Date(date + "T00:00:00Z");
  return locale === "zh-CN" || Number.isNaN(value.getTime()) ? date :
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(value);
}
