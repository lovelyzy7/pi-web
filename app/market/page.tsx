import { Suspense } from "react";
import { I18nProvider } from "@/hooks/useI18n";
import { MarketPage } from "@/components/MarketPage";

export default function MarketplacePage() {
  return (
    <Suspense>
      <I18nProvider>
        <MarketPage />
      </I18nProvider>
    </Suspense>
  );
}
