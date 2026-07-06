// Code-defined routes — no filesystem router. This is the shape that
// screen-list's route discovery cannot crawl from the directory tree
// (PLAN.md §6.2, "Vite SPA, no fs-router" row): it must either best-effort grep
// these `path:` strings out of the source, or fall back to asking the user.
import { createBrowserRouter } from "react-router-dom";
import { Home } from "./routes/Home";
import { About } from "./routes/About";
import { Products } from "./routes/Products";
import { ProductDetail } from "./routes/ProductDetail";
import { Settings } from "./routes/Settings";

export const router = createBrowserRouter([
	{ path: "/", element: <Home /> },
	{ path: "/about", element: <About /> },
	{ path: "/products", element: <Products /> },
	{ path: "/products/:id", element: <ProductDetail /> },
	{ path: "/settings", element: <Settings /> },
]);
