import React from "react";
import { createRoot } from "react-dom/client";
import PnchyBusinessFinder from "../PnchyBusinessFinder";

const rootEl = document.getElementById("pnchy-widget-root");
if (rootEl) {
  createRoot(rootEl).render(
    <PnchyBusinessFinder
      checkEndpoint="https://pnchy-business-check.aryansarin-as.workers.dev"
      supabaseUrl="https://pdcihinhmukhevuqvvcq.supabase.co"
      supabaseAnonKey="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkY2loaW5obXVraGV2dXF2dmNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NjMzOTUsImV4cCI6MjEwNDAzOTM5NX0.FX2ID6PGRqqqRSSh93pp7xvbsYWbsJqjGp7MYWLrC7I"
      earlyAccessUrl="https://pnchy.framer.website/early-access"
    />
  );
}
