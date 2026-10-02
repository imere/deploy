#!/bin/sh
# 一次性测试靶机（alpine）：sshd + rsync + sudo
set -e
apk add --no-cache openssh rsync sudo bash shadow procps-ng >/dev/null 2>&1

ssh-keygen -A >/dev/null 2>&1
mkdir -p /run/sshd /var/empty
chmod 755 /var/empty 2>/dev/null || true

adduser -D -s /bin/bash dpuser 2>/dev/null || true
echo 'dpuser:dppass123' | chpasswd
echo 'root:rootpass123' | chpasswd

printf 'dpuser ALL=(ALL) ALL\n' > /etc/sudoers.d/dpuser
chmod 0440 /etc/sudoers.d/dpuser

sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
grep -q '^PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config
grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config

cat >> /etc/ssh/sshd_config <<'EOF'
KexAlgorithms mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512,diffie-hellman-group14-sha256
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ecdsa-sha2-nistp256
EOF

# 测试素材
mkdir -p /opt/app && echo "hello-v1" > /opt/app/index.html

echo "sshd: $(ssh -V 2>&1)"
echo "rsync: $(rsync --version 2>/dev/null | head -1)"
echo "openssh_pkg: $(apk info openssh 2>/dev/null | head -1)"
nohup /usr/sbin/sshd -D -e >/tmp/sshd.log 2>&1 &
sleep 1
echo "sshd_pid=$(pgrep -x sshd | head -1)"
