import { Link } from "react-router-dom";

export function Settings() {
	return (
		<main>
			<h1>Settings</h1>
			<p>A static settings route. No auth gate on this fixture.</p>
			<Link to="/">← home</Link>
		</main>
	);
}
