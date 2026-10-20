import { S2, S2Environment } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const s2 = new S2({ ...S2Environment.parse(), accessToken });

for (const location of await s2.locations.list()) {
	console.log(location.name, {
		storageClasses: location.storageClasses,
		defaultStorageClass: location.defaultStorageClass,
	});
}
