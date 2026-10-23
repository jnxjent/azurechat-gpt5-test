/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

  async headers() {return [{source:"/teams/canvas/:path*",headers:[{key:"Content-Security-Policy",value:"frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft https://*.office.com"},{key:"Referrer-Policy",value:"no-referrer"},{key:"Cache-Control",value:"private, no-store"}]}];},

  experimental: {
    outputFileTracingIncludes: {
      "/*": [
        "./node_modules/pdfjs-dist/legacy/build/pdf.worker.js",
        "./src/scripts/**/*.py",
        "./scripts/**/*.py",
      ],
    },
    serverComponentsExternalPackages: [
      "@azure/storage-blob",
      "@napi-rs/canvas",
      "pdfjs-dist",
      "xlsx",
    ],
  },

  images: {
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "midac19-webapp-yhggrda5qr5ae.azurewebsites.net",
        pathname: "/api/images/**",
      },
      // {
      //   protocol: "https",
      //   hostname: "azurechat-gpt5-test.azurewebsites.net",
      //   pathname: "/api/images/**",
      // },
    ],
  },

  webpack: (config, { isServer }) => {
    config.module.rules.push({
      test: /\.node$/,
      use: "node-loader",
    });

    return config;
  },
};

module.exports = nextConfig;
