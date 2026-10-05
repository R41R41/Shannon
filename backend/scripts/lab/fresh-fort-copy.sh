#!/bin/bash
# A fresh copy of the L77 world on port 25651 (the original, 25650, is left as the paid runs left it).
tmux -L minebot-lab send-keys -t codex-progressive-lab-25651 "stop" Enter 2>/dev/null
until ! tmux -L minebot-lab has-session -t codex-progressive-lab-25651 2>/dev/null; do sleep 1; done
cd /home/azureuser/minecraft && rm -rf progressive-lab-p2Gj5Sfort && cp -a progressive-lab-p2Gj5S progressive-lab-p2Gj5Sfort \
  && sed -i 's/^server-port=.*/server-port=25651/; s/^query.port=.*/query.port=25651/' progressive-lab-p2Gj5Sfort/server.properties \
  && : > progressive-lab-p2Gj5Sfort/logs/latest.log \
  && tmux -L minebot-lab new-session -d -s codex-progressive-lab-25651 -c /home/azureuser/minecraft/progressive-lab-p2Gj5Sfort 'java -Xms512M -Xmx2G -jar fabric-server-launch.jar nogui'
until grep -q "Done (" progressive-lab-p2Gj5Sfort/logs/latest.log 2>/dev/null; do sleep 2; done; echo up
