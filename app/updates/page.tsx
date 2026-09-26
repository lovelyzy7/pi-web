import { Suspense } from "react";
import { I18nProvider } from "@/hooks/useI18n";
import { UpdatesPage } from "@/components/UpdatesPage";

export default function UpdatesRoutePage() {
  return (
    <Suspense>
      <I18nProvider>
        <UpdatesPage />
      </I18nProvider>
    </Suspense>
  );
}
