module.exports = {
  apps: [
    {
      name: 'SuperAppBot',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      // CRÍTICO: Variáveis de Ambiente são passadas DIRETAMENTE
      env: {
        NODE_ENV: 'production',
        PORT: 10000,
        // Chave do Gemini (já inserida)
        GEMINI_API_KEY: 'AIzaSyDSLlNgmXKWZnrZSw5qP2sbOYhMnsUZcGE',
        
        // Chave JSON do Firebase (inserida em formato de string)
        FIREBASE_SERVICE_ACCOUNT: '{"type":"service_account","project_id":"superapp-d0368","private_key_id":"79d2d36a84e78ea62fff2913839be2594746fb71","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDFG1DMtGnZ4QgQ\ndyJ9YiCCvHulCfx5cQbyTVAUAkrb03ySVJlkCrizWwwvJhCGIh82Gt3O2HAX1B8P\nqvi0Pl7q9ap8j7+QSF0LZGRKf5VmN0h81BgMU6RplRwaeGIiTDX4tr6LVtFqAerG\nwAoDRFgv8v15LslREqa/KUb+VvBYkERvmcWg1+IStYo6R8xLT0Xc058FuF3ZhO8l\nkzJ0zl6hSx7H988WuQDDBfA57DzLLhzaUsJAWeqhLD1jZ9BVcPXQDE3JishpSjik\nBylylbhkoeR805G5SWhVs5dnl6U/VXw+b/duJp6uSTmkZpE/RYg34BYClFNclrnu\n8XEmOXDlAgMBAAECggEADzSbAFu3ob0EKf8CzGDmSKehMztovHaddlJEB/MgUsKH\nJOO9XJQeKQnwT+/UDQDzXvFmJJeaWCA/UC5cls0L9fzDLO5K9Sa79M3HFd8vR44i\nu6yB+Wt3bsS3wQwB6Arwi/IPE4E8UPz6X2A/tX5Pfk10w+U51xUFA5C73xGWY4KE\n9iQcU1BZi8TH+t00fxBZRWDQckvkybAgMtoDNr/PQoeG/JI7SdCH4Oe/bgxBXT+Y\nTlTNJZCdnuPmLbhU5QkV+bEUedDHbnUEne2NXhzPEJviR88r+8ZH6zVsGWVIy0HD\nBkWbwjAfo29clwbyvgfVkimm6fYi/6o9pVDx2OR9aQKBgQDl5Cs0w7Tlou4QKikK\nJoDhBbrVhZIDD4nJB8QxNq0lpuJStkvXUZG0/14i3pIfd5UbXplsS3ZtyxGj5q3C\nv53pgZYl4+TzN04Obgi3odrDvyWswcS2lkjFWSB/Mc9W44plxABusb0a6I8ljYbk\nYtgyHcrvn+4LbOQDqqjT1MtXKQKBgQDbffjNYIBaK2EnxeeSpZR2cyncMS3oX8cT\ne9ct3VOKgmOOOb0W+MxR1MOLy1khsZQ+SZolPUvwaVAN7hLZX8wiwwv6QSiMW16O\n8+s2pvW1hVjUQqMDWA4VTytDgzj5EuNdq4HgEStOJYD14NgEAXNLI7RoN+KnMQsr\nQckHwxBvXQKBgHP1KDoAMWHXUh+DNJozG7TlL/19102F6+kj6rksLCAe0nAIFa8x\nLL7QRIpwG+KVbfeVOuweEEmHMYmr1J+0CZH71GGeVyC7F7s9k1YU5QTxiK5gOroi\niehJcZPW6w+XzHpSaCltq8ZD4dh+T7kphoWY84D0+Zx3u3eCAJCA+GQpAoGAZI7F\nEwqYIzdmjns7ydK0PsQqNGgPmTtwEDwXbDrPEFEGXV2UhNa9fOwWHpCuKCKcQSEl\nTtRTWzRUad1do1shQffMH/4EHrGpk6Kqa2J4hY4vESfqWRjZcufPcWHIE0yVABAY\nM1iKV4YVHBDDxqoHcTBNccXQwDpW3J2KBVVXzT0CgYAbBG9xk/OEWoih8XmQ3AMb\n5snb0pVPcDOraA/eNvkm2xXl4hcH8xmN5g6Afu6gaXWhtMGvtU1F7waBtbiOewgd\ne5HpL2R6WKWECVdNf434ifFcl1JW67bPZMVPA3lGptpfDQH0WeG2CgRxZc0mgvdt\nvx2y4Wc7DC1A3L0sT/Cg1Q==\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-fbsvc@superapp-d0368.iam.gserviceaccount.com","client_id":"110540385840583368447","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40superapp-d0368.iam.gserviceaccount.com","universe_domain":"googleapis.com"}'
      },
    },
  ],
};
