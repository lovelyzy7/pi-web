import { Suspense } from "react";
import { I18nProvider } from "@/hooks/useI18n";
import { UserPage } from "@/components/UserPage";

export default function AccountPage() {
  return (
    <Suspense>
      <I18nProvider>
        <UserPage />
      </I18nProvider>
    </Suspense>
  );
}
