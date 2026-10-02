import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import AddressFinder from "./pages/AddressFinder";
import Requests from "./pages/Requests";

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Requests} />
      <Route path={"/investigations"} component={AddressFinder} />
      <Route path={"/new"} component={AddressFinder} />
      <Route path={"/i/:id"} component={AddressFinder} />
      <Route path={"/requests"} component={Requests} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
