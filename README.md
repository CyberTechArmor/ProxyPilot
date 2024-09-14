# ProxyPilot
A tool to automate NGINX configuration, SSL certificate setup, and renewal with Certbot. NginxConfigGen simplifies server setups by generating scripts to configure proxies and secure your domains, making it perfect for developers and sysadmins looking to streamline their web server management.

# Test it!
https://cybertecharmor.github.io/ProxyPilot/

# NginxConfigGen 🛠️🚀

NginxConfigGen is a powerful script generator that automates the process of setting up NGINX configurations, installing SSL certificates with Certbot, and enabling automatic certificate renewals. This tool is perfect for developers, sysadmins, and web enthusiasts looking to streamline their server setup process. No more manual configuration—let NginxConfigGen do the heavy lifting! 🧰

## Features ✨

- **Automated NGINX Configuration:** Easily generate NGINX server configurations for your domains.
- **SSL Certificate Management:** Install and renew SSL certificates with Certbot effortlessly.
- **Automatic Renewals:** Ensure your certificates are always up-to-date with automated renewal setup.
- **Easy to Use:** Simple input fields and instant script generation—no command-line hassle.

## Getting Started 🏁

### Prerequisites

- **NGINX** installed on your server
- **Certbot** with the NGINX plugin available

### Installation ⚙️

Clone the repository:

```bash
git clone https://github.com/yourusername/NginxConfigGen.git
cd NginxConfigGen
```

### Usage 🚦

1. Open the project in your browser (hosted on your server or locally).
2. Enter the required information:
   - **Server Name:** The domain name for the server (e.g., `sub.domain.com`)
   - **Backend IP Address:** IP address of your backend server (e.g., `127.0.0.1`)
   - **Backend Port:** Port of your backend server (e.g., `3000`)
3. Click **Generate Script** to create your custom NGINX setup script.
4. Copy the generated script and run it on your server.

### Example Script 📝

Below is an example of a generated script:

```bash
#!/bin/bash

# Step 1: Create the NGINX Configuration File
echo "Creating NGINX configuration for sub.domain.com..."
cat <<EOL | sudo tee /etc/nginx/sites-available/sub.domain.com
server {
    listen 80;
    server_name sub.domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;  # Backend server
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOL

# Step 2: Enable the Site and Test the Configuration
echo "Enabling site and testing NGINX configuration..."
sudo ln -sf /etc/nginx/sites-available/sub.domain.com /etc/nginx/sites-enabled/
sudo nginx -t
if [ $? -ne 0 ]; then
    echo "NGINX configuration test failed. Please check your configuration."
    exit 1
fi
sudo systemctl restart nginx

# Step 3: Install Certbot and Obtain the SSL Certificate
echo "Installing Certbot and obtaining SSL certificate..."
sudo apt update
sudo apt install certbot python3-certbot-nginx -y

# Step 4: Obtain the SSL Certificate Using Certbot
echo "Running Certbot to obtain SSL certificate..."
sudo certbot --nginx -d sub.domain.com --deploy-hook "sudo systemctl restart nginx"

# Step 5: Setup Automatic Renewal
echo "Setting up automatic certificate renewal..."
sudo systemctl enable certbot.timer

echo "Setup completed successfully for sub.domain.com. Your site is now configured with SSL."
```

## Contributing 🤝

We welcome contributions! If you would like to improve NginxConfigGen, please open an issue or submit a pull request.

## License 📜

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments 🙏

- Thanks to the open-source community for providing amazing tools like NGINX and Certbot.
- Special thanks to all contributors for their valuable input.

---

Feel free to star ⭐ this project if you find it useful! We hope NginxConfigGen makes your server setup easier and more secure!
