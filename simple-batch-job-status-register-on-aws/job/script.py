import random
import multiprocessing
import time
import psutil
import argparse


def cpu_load(duration):
    """Function to load a single CPU core."""
    end_time = time.time() + duration
    while time.time() < end_time:
        x = 1234.5678
        for _ in range(1000000):
            x *= x

def monitor_cpu(duration, interval=1):
    """Function to monitor and print CPU usage."""
    end_time = time.time() + duration
    while time.time() < end_time:
        cpu_percent = psutil.cpu_percent(interval=interval)
        print(f"CPU Usage: {cpu_percent}%")

def main(duration, cores):
    """Main function to start CPU load and monitoring."""
    if cores == 0:
        cores = multiprocessing.cpu_count()

    print(f"Starting CPU load test for {duration} seconds on {cores} cores")

    # Start the monitoring process
    monitor_process = multiprocessing.Process(target=monitor_cpu, args=(duration,))
    monitor_process.start()

    # Start the CPU loading processes
    processes = []
    for _ in range(cores):
        p = multiprocessing.Process(target=cpu_load, args=(duration,))
        processes.append(p)
        p.start()

    # Wait for all processes to complete
    for p in processes:
        p.join()

    monitor_process.join()

    print("CPU load test completed")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CPU Load Testing Script")

    parser.add_argument("--auto", action="store_true",
                        help="Enable auto mode to adjust core usage based on system load")

    parser.add_argument("-d", "--duration", type=int, default=60,
                        help="Duration of the test in seconds (default: 60)")
    parser.add_argument("-c", "--cores", type=int, default=0,
                        help="Number of cores to use. 0 means use all available cores (default: 0)")
    args = parser.parse_args()

    if args.auto:
        print('Running in a random configuration')
        main(random.randint(0, 60), 0)
    else:
        main(args.duration, args.cores)
